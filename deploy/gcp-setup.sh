#!/usr/bin/env bash
# Reference commands for deploying company-categorizer-ts to Google Cloud as a
# Cloud Run JOB triggered on a schedule by Cloud Scheduler.
#
# Why a Job and not a Service: the app has no HTTP server. It wakes up, works a
# batch of rows, and exits. A Service would have to stay alive 24/7 to run
# node-cron inside it and you'd pay for idle time. A Job bills only for the
# seconds it actually runs.
#
# This file is a REFERENCE. Read it, edit the variables, run the sections one
# at a time. Do not execute it unattended. Prose walkthrough: ../SETUP.md

set -euo pipefail

# ---- 1. Variables - EDIT THESE ----
PROJECT_ID="your-gcp-project-id"
REGION="us-central1"                     # closest to you / to your database
REPO="company-categorizer-ts"
JOB_NAME="company-categorizer-ts"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB_NAME}:latest"
SCHEDULER_JOB="company-categorizer-ts-trigger"
SCHEDULE="*/15 * * * *"
SA_NAME="company-categorizer-ts-invoker"

# ---- 2. One-time project setup ----
gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com   # only if Postgres is Cloud SQL

gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="company-categorizer-ts images"

# ---- 3. Secrets ----
# Run these interactively so values don't land in shell history:
#   printf '%s' 'sk-ant-...' | gcloud secrets create ANTHROPIC_API_KEY --data-file=-
#   printf '%s' 'fc-...'     | gcloud secrets create FIRECRAWL_API_KEY --data-file=-
#   printf '%s' 'postgresql://user:pass@host:5432/db' | gcloud secrets create DATABASE_URL --data-file=-
#   printf '%s' 'tvly-...'   | gcloud secrets create TAVILY_API_KEY --data-file=-     # only with Tavily
#   gcloud secrets create SSH_PRIVATE_KEY --data-file=/path/to/key                    # SSH tunnel, key auth
#   printf '%s' 'your-ssh-password' | gcloud secrets create SSH_PASSWORD --data-file=-  # SSH tunnel, password auth
#     (optionally also set SSH_HOST_FINGERPRINT in --set-env-vars below to pin
#      the host key - recommended, not required; see SETUP.md "SSH by password")
#
# Tuning values (batch size, concurrency, rate limits, model, cache TTL) are
# deliberately NOT secrets - they go in --set-env-vars so they can be changed
# with one `gcloud run jobs update` and no rebuild.

# ---- 4. Build and push (Cloud Build; no local Docker needed) ----
gcloud builds submit --tag "$IMAGE" .

# ---- 5. Create the Job ----
# --max-retries=1: a retried task re-claims rows, and every claim spends scrape
# and model credits. Per-row failures are already written to metadata.errors,
# so the next scheduled run picks them up instead.
gcloud run jobs create "$JOB_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --cpu=1 \
  --memory=512Mi \
  --max-retries=1 \
  --task-timeout=900s \
  --set-env-vars="ANTHROPIC_MODEL=claude-sonnet-4-6,\
ANTHROPIC_CACHE_TTL=1h,\
ANTHROPIC_PROMPT_CACHE=true,\
ANTHROPIC_RPM=40,\
ANTHROPIC_CONCURRENCY=4,\
FIRECRAWL_RPM=20,\
FIRECRAWL_CONCURRENCY=4,\
BATCH_SIZE=25,\
PIPELINE_CONCURRENCY=4,\
MAX_RETRIES=5,\
STALE_CLAIM_MS=900000,\
DATABASE_SSL=true,\
TAVILY_ENABLED=false,\
SCRAPE_PROVIDER=firecrawl,\
SCRAPE_FALLBACK_PROVIDER=none" \
  --set-secrets="ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,\
FIRECRAWL_API_KEY=FIRECRAWL_API_KEY:latest,\
DATABASE_URL=DATABASE_URL:latest"

# Cloud SQL instead of a public host: add
#   --add-cloudsql-instances="$PROJECT_ID:$REGION:your-instance"
# and set DATABASE_URL to the socket form, with DATABASE_SSL=false:
#   postgresql://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE
#
# Postgres behind an SSH bastion, key auth: add to --set-env-vars
#   SSH_TUNNEL_ENABLED=true,SSH_HOST=...,SSH_PORT=22,SSH_USERNAME=...
# and to --set-secrets
#   SSH_PRIVATE_KEY=SSH_PRIVATE_KEY:latest
#
# Postgres behind an SSH bastion, PASSWORD auth (this is your setup): add to
# --set-env-vars
#   SSH_TUNNEL_ENABLED=true,SSH_HOST=...,SSH_PORT=22,SSH_USERNAME=...
# and to --set-secrets
#   SSH_PASSWORD=SSH_PASSWORD:latest
# That's sufficient to connect. Optionally add SSH_HOST_FINGERPRINT=... to
# --set-env-vars to pin the host key (not a secret) - see SETUP.md "SSH by
# password" for why that's worth doing and how to capture it.
#
# Either way, DATABASE_URL uses Postgres's address as seen from the VPS
# itself (127.0.0.1:5432), and DATABASE_SSL=false (the tunnel is the encryption).

# ---- 6. Schedule it ----
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Invokes the company-categorizer-ts Cloud Run Job"

gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"

gcloud scheduler jobs create http "$SCHEDULER_JOB" \
  --location="$REGION" \
  --schedule="$SCHEDULE" \
  --uri="$JOB_URI" \
  --http-method=POST \
  --oauth-service-account-email="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Overlapping executions are safe: rows are claimed with FOR UPDATE SKIP
# LOCKED, so a second run takes different rows rather than repeating work.

# ---- 7. Test ----
#   gcloud run jobs execute "$JOB_NAME" --region="$REGION" --wait
#   gcloud run jobs executions list --job="$JOB_NAME" --region="$REGION"
#   gcloud beta run jobs executions logs read EXECUTION_NAME --region="$REGION"

# ---- 8. Change settings later, no rebuild ----
#   gcloud run jobs update "$JOB_NAME" --region="$REGION" \
#     --update-env-vars="BATCH_SIZE=50,PIPELINE_CONCURRENCY=6"
#
# Turn Tavily on in production:
#   printf '%s' 'tvly-...' | gcloud secrets create TAVILY_API_KEY --data-file=-
#   gcloud run jobs update "$JOB_NAME" --region="$REGION" \
#     --update-env-vars="TAVILY_ENABLED=true,SCRAPE_FALLBACK_PROVIDER=tavily" \
#     --update-secrets="TAVILY_API_KEY=TAVILY_API_KEY:latest"

# ---- 9. OPTIONAL: the HTTP API as a Cloud Run SERVICE ----
# Same image as the Job; only the command differs. The Job keeps running the
# batch on its schedule - the two coexist safely (see README "HTTP API").
#
#   printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create API_KEY --data-file=-
#
#   gcloud run deploy company-categorizer-api \
#     --image="$IMAGE" --region="$REGION" \
#     --command=node --args=dist/server.js \
#     --cpu=1 --memory=512Mi \
#     --timeout=900 \           # a request waits for the scrape + model calls
#     --concurrency=20 --max-instances=3 \
#     --no-cpu-throttling \      # keeps CPU on between requests; needed if you use the SSH tunnel
#     --allow-unauthenticated \  # callers still need the API key; drop this to use IAM instead
#     --set-env-vars="<same tuning + provider vars as the Job>" \
#     --set-secrets="API_KEY=API_KEY:latest,<same secrets as the Job>"
#
# Cloud Run sends SIGTERM and allows ~10s before killing the instance; the
# server uses that window to let in-flight research reach the database.

# ---- 10. The multi-tenant Deeluge app (README "Deeluge app") ----
# Needs the service from step 9. --no-cpu-throttling matters: categorizing
# finishes in the background after Deeluge has had its answer.
#
#   printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create ADMIN_API_KEY --data-file=-
#   printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create SECRETS_ENCRYPTION_KEY --data-file=-
#
#   SERVICE_URL=$(gcloud run services describe company-categorizer-api --region="$REGION" --format='value(status.url)')
#   gcloud run services update company-categorizer-api --region="$REGION" \
#     --update-env-vars="PUBLIC_URL=${SERVICE_URL},APP_DEVELOPER_NAME=Automation Consulting Services" \
#     --update-secrets="ADMIN_API_KEY=ADMIN_API_KEY:latest,SECRETS_ENCRYPTION_KEY=SECRETS_ENCRYPTION_KEY:latest"
#
# Then open ${SERVICE_URL}/setup, sign in with the admin key and add organizations.
# Organizations' signing secrets and keys go in the database through that page,
# never into Secret Manager or env vars.
