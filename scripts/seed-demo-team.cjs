"use strict";
const { randomBytes, randomUUID, scryptSync } = require("node:crypto");
const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(String(password), salt, 64).toString("hex")}`;
}

const db = openDatabase(loadConfig().databasePath),
  password = process.env.DEMO_PASSWORD || "DemoPass123!",
  people = [
    ["admin@ithealthtech.com", "IT HealthTech Admin", "Administrator", "admin"],
    ["tyler@ithealthtech.com", "Tyler Gifol", "President", "admin"],
    ["alex@ithealthtech.com", "Alex Rivera", "Service Manager", "editor"],
    [
      "morgan@ithealthtech.com",
      "Morgan Chen",
      "Cloud Solutions Lead",
      "editor",
    ],
    ["sam@ithealthtech.com", "Sam Patel", "Account Coordinator", "viewer"],
  ];

db.exec("BEGIN IMMEDIATE");
try {
  db.prepare(
    `INSERT INTO organizations(id,name,slug,settings_json) VALUES ('org-demo','IT HealthTech','it-healthtech',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,settings_json=excluded.settings_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    JSON.stringify({
      publicUrl: "http://127.0.0.1:4173",
      assetBaseUrl: "http://127.0.0.1:4173",
      mediaBaseUrl: "http://127.0.0.1:4173",
      sessionHours: 12,
    }),
  );
  db.prepare(
    `INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at) VALUES ('org-demo','beta','trialing',10,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')) ON CONFLICT(organization_id) DO NOTHING`,
  ).run();
  for (const [email, name, jobTitle, role] of people) {
    const existing = db
        .prepare(
          "SELECT id,password_hash FROM signature_users WHERE lower(email)=lower(?)",
        )
        .get(email),
      id = existing?.id || randomUUID(),
      signature = {
        templateId: "modernMinimal",
        fields: {
          name,
          jobTitle,
          department: role === "admin" ? "Leadership" : "Service",
          company: "IT HealthTech",
          email,
          phone: "(732) 456-0100",
          mobile: "",
          website: "https://ithealthtech.com",
          address: "",
          social: { linkedin: "", facebook: "", instagram: "", x: "" },
        },
        colors: { accent: "#2563eb", text: "#172033" },
        photoUrl: "",
        bannerUrl: "",
        campaignId: "",
        workflowStatus: "approved",
      };
    db.prepare(
      `INSERT INTO signature_users(id,email,password_hash,display_name,role,status,signature_json,email_verified_at) VALUES (?,?,?,?,?,'active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(email) DO UPDATE SET display_name=excluded.display_name,status='active',signature_json=excluded.signature_json,email_verified_at=COALESCE(signature_users.email_verified_at,excluded.email_verified_at),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(
      id,
      email,
      existing?.password_hash || hashPassword(password),
      name,
      role,
      JSON.stringify(signature),
    );
    db.prepare(
      `INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES ('org-demo',?,?,'active',?) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,status='active',signature_json=excluded.signature_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(id, role, JSON.stringify(signature));
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

console.log(
  `Seeded ${people.length} demo members in the IT HealthTech workspace.`,
);
console.log(`Password for newly created demo accounts: ${password}`);
