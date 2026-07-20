"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const {
  consistentSnapshot,
  deployArtifact,
  verifyArtifact,
} = require("../server/deployment.cjs");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(root, version, commit, content) {
  const directory = path.join(root, `artifact-${version}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "server.cjs"), content);
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ version, commit }),
  );
  const manifest = fs.readFileSync(path.join(directory, "manifest.json"));
  fs.writeFileSync(
    path.join(directory, "checksums.txt"),
    `${digest(manifest)}  manifest.json\n${digest(content)}  server.cjs\n`,
  );
  return directory;
}

function opener(expectedCopy) {
  return (file) => {
    assert.notEqual(path.resolve(file), path.resolve(expectedCopy));
    assert.equal(fs.readFileSync(file, "utf8"), "database");
    return {
      prepare(sql) {
        return {
          get() {
            return sql.includes("integrity_check")
              ? { integrity_check: "ok" }
              : { count: 20 };
          },
        };
      },
      close() {},
    };
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-deployment-")),
    releases = path.join(root, "releases"),
    current = path.join(root, "current"),
    database = path.join(root, "signify.db"),
    backups = path.join(root, "backups"),
    oldArtifact = artifact(root, "1.0.0", "1".repeat(40), "old"),
    newArtifact = artifact(root, "1.1.0", "2".repeat(40), "new"),
    badArtifact = artifact(root, "1.2.0", "3".repeat(40), "bad");
  const workflow = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      ".github",
      "workflows",
      "npm-publish-github-packages.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /deploy-staging:/);
  assert.match(workflow, /deploy-production:[\s\S]*needs: deploy-staging/);
  assert.match(workflow, /SIGNIFY_SSH_KNOWN_HOSTS/);
  assert.equal((workflow.match(/Invalid deploy root/g) || []).length, 2);
  const liveDatabase = path.join(root, "live-wal.db"),
    snapshot = path.join(root, "consistent.db"),
    live = new DatabaseSync(liveDatabase);
  live.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('committed-in-wal');",
  );
  consistentSnapshot(liveDatabase, snapshot);
  const copied = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal(
    copied.prepare("SELECT value FROM probe").get().value,
    "committed-in-wal",
  );
  copied.close();
  live.close();
  fs.writeFileSync(database, "database");
  fs.mkdirSync(releases);
  const oldRelease = path.join(releases, "1.0.0-111111111111");
  fs.cpSync(oldArtifact, oldRelease, { recursive: true });
  fs.symlinkSync(
    oldRelease,
    current,
    process.platform === "win32" ? "junction" : "dir",
  );

  const verified = verifyArtifact(newArtifact);
  assert.equal(verified.files, 2);
  fs.appendFileSync(path.join(badArtifact, "server.cjs"), "tampered");
  assert.throws(() => verifyArtifact(badArtifact), /checksum mismatch/i);

  let restarts = 0,
    probes = 0,
    installs = 0;
  const deployed = await deployArtifact({
    artifact: newArtifact,
    releasesDirectory: releases,
    currentLink: current,
    databasePath: database,
    backupDirectory: backups,
    backupDatabase: (source, directory) => {
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, "pre-deploy.db");
      fs.copyFileSync(source, target);
      return target;
    },
    openDatabase: opener(database),
    snapshotDatabase: (source, target) => fs.copyFileSync(source, target),
    install: async (release, manifest) => {
      installs += 1;
      assert(fs.existsSync(path.join(release, "server.cjs")));
      assert.equal(manifest.version, "1.1.0");
    },
    restart: async () => {
      restarts += 1;
    },
    probe: async () => {
      probes += 1;
    },
  });
  assert.equal(deployed.status, "activated");
  assert.equal(deployed.preflight.migrations, 20);
  assert(fs.existsSync(deployed.safetyBackup));
  assert.equal(path.basename(fs.realpathSync(current)), "1.1.0-222222222222");
  assert.equal(restarts, 1);
  assert.equal(probes, 1);
  assert.equal(installs, 1);

  let rollbackProbes = 0;
  await assert.rejects(
    deployArtifact({
      artifact: artifact(root, "1.2.0", "4".repeat(40), "rollback"),
      releasesDirectory: releases,
      currentLink: current,
      databasePath: database,
      backupDirectory: backups,
      backupDatabase: (source, directory) => {
        const target = path.join(directory, "pre-deploy-rollback.db");
        fs.copyFileSync(source, target);
        return target;
      },
      openDatabase: opener(database),
      snapshotDatabase: (source, target) => fs.copyFileSync(source, target),
      restart: async () => {},
      probe: async () => {
        rollbackProbes += 1;
        if (rollbackProbes === 1) throw new Error("candidate unhealthy");
      },
    }),
    (error) => error.code === "DEPLOYMENT_ROLLED_BACK",
  );
  assert.equal(path.basename(fs.realpathSync(current)), "1.1.0-222222222222");
  assert.equal(rollbackProbes, 2);

  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  console.log(
    "Deployment test passed: artifact verification, migration preflight, atomic activation, health gate, and rollback",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
