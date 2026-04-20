# NEXUS

NEXUS is a Flutter + Firebase crisis coordination application focused on rapid incident reporting, staff assignment, emergency dispatch, and reliability under free-tier constraints.

This repository contains a complete free-tier MVP with:

- Multi-role workflow (Guest, Staff, Admin)
- Incident lifecycle and assignment
- Dispatch queue and retry queue
- Offline queueing and auto-sync
- SLA escalation watchdogs
- Audit trail logging
- External webhook dispatch integration
- Staff push notifications using a Cloudflare Worker relay

## Product Overview

NEXUS helps teams handle emergency events from report to resolution.

- Guests trigger SOS incidents
- AI-assisted classification determines type and severity
- Staff are auto-assigned based on availability
- Admin sees live incident/dispatch/retry dashboards
- System retries and escalates when acknowledgements are delayed

## Implemented Features

### 1. Incident Management

- Create incidents with crisis type, severity, zone, and description
- Real-time incident streaming to Admin and Staff views
- Staff assignment and status transitions (active, assigned, resolved)
- Resolution workflow with timeline events

### 2. Role-Based Access

- Firebase Auth sign-in/register
- Role lookup using deterministic membership docs:
	- adminEmails/{email}
	- staffEmails/{email}
- Backward-compatible lookup for legacy random-ID membership docs

### 3. Dispatch and Retry

- Dispatch jobs stored in dispatchQueue
- Admin actions: Mark Sent, Mark Failed, Retry Failed
- Failed operations captured in retryQueue
- External dispatch sent via HTTP webhook

### 4. Reliability (Free-Tier)

- Local offline queue for SOS trigger failures
- Auto-flush of queued incidents on periodic retry
- Local SLA watchdog for escalations:
	- no assignment after ~2 minutes
	- no acknowledgement after ~3 minutes
- Incident events/audit log under incidents/{id}/events
- Acknowledgement timeline under incidents/{id}/acks

### 5. Notifications

- Staff FCM token capture and refresh
- Android push delivery path via Cloudflare Worker relay (FCM HTTP v1)
- Push attempt success/failure tracked in incident events/retry queue

### 6. Web + Android Compatibility

- Web dispatch supports CORS-aware error handling
- Android manifest includes internet/network/notification permissions
- Environment-based URL fallback for webhook endpoints

## Architecture

### Core Stack

- Flutter (Dart)
- Firebase Authentication
- Cloud Firestore
- Firebase Messaging (token/device side)
- Cloudflare Worker (push relay)

### Collections Used

- incidents
- incidents/{id}/events
- incidents/{id}/acks
- staff
- guests
- staffEmails
- adminEmails
- dispatchQueue
- retryQueue
- appConfig

## Free-Tier Strategy

Cloud Functions in this project are present in source but not required for the MVP path.

Because Spark-tier restrictions can block functions deployment, NEXUS implements client-side fallbacks for:

- SLA escalation checks
- offline queue retry
- dispatch webhook sends

Push notifications are delivered through a Cloudflare Worker relay so no paid Firebase backend service is required for this flow.

## Environment Configuration

Create a local .env file in project root with:

GEMINI_API_KEY=your_gemini_key
DISPATCH_WEBHOOK_URL=https://your-dispatch-endpoint
STAFF_PUSH_WORKER_URL=https://your-cloudflare-worker-url

Notes:

- Do not commit .env to source control
- Restart the app after changing .env values

## Cloudflare Worker for Staff Push

Worker files are provided in:

- cloudflare/staff-push-worker.js
- cloudflare/wrangler.toml

Required Worker settings:

- Secret: FCM_SERVICE_ACCOUNT_JSON (full Firebase service account JSON)
- Variable: FCM_PROJECT_ID=solutions-a0d47

## Setup

1. Install dependencies

flutter pub get

2. Configure Firebase files for your local environment

- Android: android/app/google-services.json
- iOS: ios/Runner/GoogleService-Info.plist (if using iOS)

3. Deploy Firestore rules

firebase deploy --only firestore:rules

4. Configure .env values

5. Run app

- Android: flutter run -d <device_id>
- Web: flutter run -d chrome

## Security and Privacy

- Secrets and keys are excluded via .gitignore
- Firebase service account keys must never be committed
- If a key is ever exposed, rotate it immediately in Google Cloud IAM
- Keep worker secrets only in Cloudflare secret storage

## Current Status

NEXUS is a functional free-tier MVP and is suitable for demo and iterative production hardening.

Completed:

- Incident lifecycle
- Assignment + acknowledgements
- Dispatch + retry queues
- Offline queue + auto flush
- SLA watchdog + escalation entries
- Webhook dispatch
- Staff push relay integration

Remaining hardening (recommended):

- Full end-to-end acceptance checklist on target devices/networks
- Monitoring/alerting around relay failures
- Optional migration to server-side automations when budget allows

## Repository Structure (High Level)

- lib/
	- providers/ (auth, incident orchestration)
	- services/ (auth, firestore, ai, local queue)
	- screens/ (admin, staff, guest, auth)
- cloudflare/
	- staff-push-worker.js
	- wrangler.toml
- functions/
	- reference Firebase Functions source (optional path)
- android/
- firestore.rules
- firebase.json

## License

This project is licensed under the Apache License 2.0.

See [LICENSE](LICENSE) for details.
