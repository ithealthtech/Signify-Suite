---
layout: default
title: Troubleshooting
description: Diagnose Signify Creator installation, login, storage, Microsoft 365, email, update, backup, and browser problems.
---

# Troubleshooting

Use this guide to identify common problems without exposing passwords, tokens, or
customer data.

[Home](Home.md) | [Installation](Installation.md) | [Configuration](Configuration.md)

## Start With These Checks

1. Confirm the Node.js application is running.
2. Open `/api/live` and `/api/ready` on the Signify domain.
3. Confirm the domain uses HTTPS.
4. Confirm the database and media paths are persistent and writable.
5. Review the most recent application logs.
6. Run `npm run doctor` when terminal access is available.

```bash
npm run doctor
```

Do not post the complete environment file or unredacted logs in a support issue.

## Setup Page Does Not Open

### Symptoms

- The domain shows a host error or blank page.
- `/setup.html` returns not found.
- The application repeatedly restarts.

### Checks

1. Confirm Node.js 22.13 or newer is selected.
2. Confirm the entry file is `server.cjs`.
3. Confirm dependencies were installed with `npm ci --omit=dev`.
4. Confirm the assigned port matches `PORT`.
5. Confirm the host can execute Node.js applications rather than static sites.
6. Review startup logs for a missing or invalid required setting.

### Common Fix

On managed hosting, use:

```text
Framework: Other
Entry file: server.cjs
Build command: npm run build
```

## Setup Token Is Rejected

- Copy the value directly from the host secret panel.
- Make sure it contains at least 32 characters.
- Do not add quotation marks unless the host requires them.
- Restart the application after adding or changing the token.
- Confirm you are opening the same installation where the token was configured.

Generate a new token only before setup is complete:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Remove the setup token after installation.

## Initial Workspace Is Unavailable

1. Finish all three setup stages.
2. Restart after removing `SIGNIFY_SETUP_TOKEN`.
3. Confirm `DATABASE_PATH` points to a writable persistent folder.
4. Confirm the database file exists after setup.
5. Run `npm run doctor`.
6. Review logs for a migration or storage error.

Do not create a second fresh database to hide the problem. Repair the storage path
or restore the intended backup.

## Signify Starts as a New Installation After Restart

The database is being written to a temporary folder.

### Fix

1. Stop Signify.
2. Find the correct existing `signify-creator.db` and its WAL/SHM files when
   present.
3. Back up those files.
4. Move them to the host's persistent storage.
5. Update `DATABASE_PATH`.
6. Start Signify and verify users and templates.

Do not merge two different database files manually.

## Login Fails

### Invalid Email or Password

- Confirm there are no leading or trailing spaces.
- Confirm the account is active.
- Use password reset when transactional email is configured.
- Ask a Tenant Admin to reset or recreate a tenant account when appropriate.
- Use the administrator reset script only with authorized server access.

### MFA Code Is Rejected

- Confirm the server and authenticator phone have accurate time.
- Enter the current code before it changes.
- Try one unused recovery code.
- Do not reuse a consumed recovery code.

### Application Owner Is Blocked by MFA Setup

This is expected in production. Complete authenticator enrollment before opening
other Application sections.

## Page Will Not Load or Shows “Failed to Fetch”

1. Open `/api/ready` in the same browser.
2. Confirm the domain and configured `SIGNIFY_PUBLIC_URL` match.
3. Check the browser network panel for a failed API request.
4. Confirm the reverse proxy forwards requests to the correct Node.js port.
5. Confirm HTTPS proxy headers are forwarded and `TRUST_PROXY=true` when needed.
6. Check server logs using the request ID from the error response.

Do not open `signature.html` directly from the filesystem. Use the running Node.js
address.

## Changes Do Not Save

- Confirm the account has permission to edit the selected employee.
- Check for a validation message or expired session.
- Confirm `/api/ready` is healthy.
- Confirm the database folder remains writable.
- Refresh and verify whether the saved value persisted.
- Review logs for CSRF, authorization, storage, or validation errors.

The interface should not claim success unless the server completed the save.

## Preview Does Not Update

1. Select a different field and return to trigger normal input handling.
2. Confirm the selected employee has a template.
3. Check for blocked or missing image addresses.
4. Remove an invalid website or social address.
5. Refresh and reopen the employee.
6. Review browser console errors.

If exported HTML is correct but the live preview is not, include the browser and
exact reproduction steps in the issue without including employee private data.

## Images or Banners Are Missing

- Confirm the asset address uses HTTPS.
- Confirm the media path or S3 bucket is available.
- Confirm the tenant media limit is not exceeded.
- Confirm the file type is supported.
- Confirm the file was not deleted from persistent storage during deployment.
- Verify that the image opens through the application, not by exposing a private
  object-storage key.

## Banner Is Enlarged During Animation

1. Confirm the source and output dimensions match the intended email width.
2. Remove transparent padding from the source image.
3. Preview every animation frame.
4. Test the generated banner in Outlook desktop and Outlook web.
5. Use a static banner until the animation passes size verification.

An animation should change pixels, not the final layout dimensions.

## Campaign Does Not Appear

Check:

- Campaign status is Active.
- Start and end dates include the current date.
- A saved banner is selected.
- The campaign scope includes the employee.
- The employee signature uses a layout that supports campaigns.
- The browser or mail client is not showing a cached signature.

## Transactional Email Will Not Connect

- Confirm the API key begins with the expected provider prefix.
- Confirm the sender domain is verified.
- Confirm the sender format is valid.
- Confirm the host allows outbound HTTPS.
- Send a test message to an address you control.
- Review provider logs without copying the API key.

Keep public registration disabled while email readiness is failing.

## Microsoft 365 Will Not Connect

### Application Connection

Confirm:

- Client ID and home tenant ID are correct.
- Client secret is current and not the secret's display ID.
- Both redirect addresses match exactly.
- Required Microsoft Graph permissions are present.
- Administrator consent was granted.

### Tenant Connection

Confirm the person granting consent is a Microsoft 365 Global Administrator and
is connecting the intended tenant.

### Directory Synchronization

- Review the background job result.
- Confirm `User.Read.All` and `Organization.Read.All` application permissions.
- Confirm consent has not been revoked.
- Correct the permission problem before retrying a dead-lettered job.

### Mail Delivery

- Confirm `Mail.Send` application permission.
- Confirm the sender mailbox exists and is licensed as required by Microsoft.
- Confirm the sender address belongs to the connected tenant.
- Test with a non-production mailbox first.

## GitHub Release Channel Cannot Be Reached

Confirm:

- Repository is `ithealthtech/Signify-Suite`.
- The token is empty for the public release channel, or an optional token has
  repository **Contents: Read-only** access.
- An optional token has not expired or been revoked.
- The host allows outbound HTTPS to GitHub.
- A normal GitHub release exists, not only a tag or draft.

Revoke and replace any token accidentally included in a URL, screenshot, log, or
support message.

## Update Is Found but Cannot Be Installed

Release detection and one-click installation are separate capabilities.

One-click installation requires:

- Persistent release directory
- Stable current-release link
- Host restart script
- Local readiness address
- Official release verification public key
- Permission for the Node.js process to stage the release

If the host does not permit these controls, install the verified release through
the hosting panel.

## Backup Fails

- Confirm `BACKUP_DIR` exists and is writable.
- Confirm there is enough disk space.
- Confirm the database and media folders are readable.
- Review off-site storage credentials when enabled.
- Do not delete old backups until a new backup completes and verifies.

## Restore Does Not Complete

1. Confirm the restore package checksum is valid.
2. Confirm the backup belongs to the intended installation.
3. Stop the separate worker.
4. Restart the web process so it can apply the staged restore.
5. Review restore logs and readiness.
6. Keep the pre-restore safety backup.

Do not repeatedly stage different backups without understanding the first failure.

## Background Job Is Dead-Lettered

1. Open **Application > Background jobs**.
2. Read the stored error.
3. Identify the provider, permission, data, or storage problem.
4. Fix the root cause.
5. Requeue the existing job with a clear reason.

Do not edit the job database table manually.

## Community Limit Was Reached

Community Edition supports one workspace and up to 10 users. Pending invitations
also reserve user capacity.

Deactivate or remove unused accounts and invitations, or activate a license with
additional rights. The server enforces limits even when an API is called directly.

## Stripe Is Not Visible

This is expected unless the installation has an active Enterprise license with
the tenant billing entitlement. Stripe remains hidden and inactive in Community
and other non-Enterprise editions.

## Information to Include in a Support Issue

Include:

- Signify version
- Hosting type and Node.js version
- Exact page or workflow
- Expected result and actual result
- Time of the failure and request ID
- Sanitized error message
- Reproduction steps
- Whether the problem survives restart

Do not include:

- Passwords or MFA codes
- Setup token
- Encryption key
- Microsoft, Stripe, Resend, S3, or GitHub credentials
- Customer data
- Unredacted database files or logs
