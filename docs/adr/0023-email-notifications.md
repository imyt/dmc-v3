# 0023. Email notifications with nodemailer

Status: accepted (the new dependency needs a human to confirm it, per rule 11)

## Decision
The worker sends email for new tasks, escalations, raised exceptions and deadline reminders. It uses `nodemailer` (the long-standing SMTP client for Node) in `apps/worker` only. Teams and other channels are not built.

## How it works
- `Notifier`/`MailSender` is a port; the SMTP sender is one implementation, a log-line sender is the other. With no `DMC_SMTP_HOST` set, nothing is sent and each message is written to the log, as before.
- Which events were already mailed is kept in the workflow module's `notification` table (one row per event key), claimed before sending, so an event is never mailed twice, whatever the number of workers or restarts. A failed send releases the claim and is retried on the next housekeeping tick.
- Recipients: a person id resolves to the email on their Person node, else to the local user list (`config/local-users.json`); a route or group name resolves through `config/notifications.yaml`. An assignee with no address is recorded as "no recipient" and logged once.
- Configuration is by environment (`DMC_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASSWORD_REF`, `_FROM`; the password itself is `DMC_SECRET_<REF>`). Locally a `mailpit` container catches everything.

## Consequences
- One new runtime dependency (`nodemailer`) and its type package (dev).
- Turning notifications on for an estate with open tasks mails each of them once.
- Rollback: unset `DMC_SMTP_HOST`.
