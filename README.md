# Disk Space Calculator — Azure Deployment Guide

Deploy the BBB disk space calculator to **Azure Static Web Apps** with **Azure Cosmos DB** as the storage backend for saved scenarios.

## What you're deploying

- **Frontend:** the calculator HTML (`index.html`), modified to detect cloud mode and sync saved scenarios over an API
- **Backend:** a single Azure Function (`/api/scenarios`) handling CRUD for saved scenarios
- **Storage:** Cosmos DB for NoSQL (serverless tier, free)
- **Auth:** Microsoft Entra ID — only signed-in tenant users can save to the cloud

Signed-in users get cross-device saved scenarios. Anonymous visitors fall back to `localStorage` automatically, so the tool keeps working either way.

## Repo layout

```
disk-calc-azure/
├── index.html                      ← cloud-aware calculator
├── staticwebapp.config.json        ← SWA auth + routing
├── .gitignore
└── api/
    ├── host.json                   ← Functions runtime config
    ├── package.json                ← @azure/cosmos dependency
    └── scenarios/
        ├── function.json           ← HTTP route: /api/scenarios/{id?}
        └── index.js                ← CRUD handler
```

## Prerequisites

- Azure subscription with rights to create Resource Groups, Static Web Apps, Cosmos DB accounts, and App Registrations
- A GitHub account with repo-create permissions
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) installed locally, signed in via `az login`
- Git installed locally

---

## Phase 1 — Push the repo to GitHub

1. On github.com, create a new empty repo named `disk-calc-azure`. Don't add a README — these files become the initial commit.
2. From the unzipped folder, on your machine:

```bash
cd disk-calc-azure
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/disk-calc-azure.git
git push -u origin main
```

## Phase 2 — Create the Static Web App

The SWA resource also wires up a GitHub Actions workflow so every push to `main` deploys automatically.

```bash
RG=rg-bbb-tools
LOC=eastus2          # or southeastasia, etc.
GITHUB_REPO=https://github.com/<YOUR_USER>/disk-calc-azure

az group create --name $RG --location $LOC

az staticwebapp create \
  --name swa-disk-calculator \
  --resource-group $RG \
  --source $GITHUB_REPO \
  --location $LOC \
  --branch main \
  --app-location "/" \
  --api-location "api" \
  --login-with-github \
  --sku Free
```

The first GitHub Actions run takes ~2 minutes. Get the live URL:

```bash
SWA_HOST=$(az staticwebapp show --name swa-disk-calculator --resource-group $RG --query defaultHostname -o tsv)
echo https://$SWA_HOST
```

Open it. The calculator should load. Saved Scenarios will show "Error: HTTP 401" — expected, since auth isn't wired yet. The rest of the tool works.

## Phase 3 — Provision Cosmos DB

```bash
COSMOS_ACCT=cosmos-bbb-tools

az cosmosdb create \
  --name $COSMOS_ACCT \
  --resource-group $RG \
  --locations regionName=$LOC \
  --capabilities EnableServerless \
  --enable-free-tier true

az cosmosdb sql database create \
  --account-name $COSMOS_ACCT \
  --resource-group $RG \
  --name bbb-tools

az cosmosdb sql container create \
  --account-name $COSMOS_ACCT \
  --resource-group $RG \
  --database-name bbb-tools \
  --name saved-scenarios \
  --partition-key-path "/userId"
```

The free tier gives 1000 RU/s and 25GB free *forever* per subscription. Serverless billing only kicks in past that.

Grab the endpoint and primary key:

```bash
COSMOS_ENDPOINT=$(az cosmosdb show --name $COSMOS_ACCT --resource-group $RG --query documentEndpoint -o tsv)
COSMOS_KEY=$(az cosmosdb keys list --name $COSMOS_ACCT --resource-group $RG --type keys --query primaryMasterKey -o tsv)
```

## Phase 4 — Wire Cosmos DB into the Static Web App

```bash
az staticwebapp appsettings set \
  --name swa-disk-calculator \
  --resource-group $RG \
  --setting-names \
    "COSMOS_ENDPOINT=$COSMOS_ENDPOINT" \
    "COSMOS_KEY=$COSMOS_KEY" \
    "COSMOS_DATABASE=bbb-tools" \
    "COSMOS_CONTAINER=saved-scenarios"
```

These appear in the API's environment at runtime — the Function reads them via `process.env`.

## Phase 5 — Configure Entra ID authentication

The SWA config requires authenticated users for `/api/scenarios*`. Wire it to your tenant.

1. Get your tenant ID:

```bash
TENANT_ID=$(az account show --query tenantId -o tsv)
echo $TENANT_ID
```

2. Register an Entra ID app for the calculator:

```bash
APP_ID=$(az ad app create \
  --display-name "Disk Space Calculator (BBB)" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://$SWA_HOST/.auth/login/aad/callback" \
  --enable-id-token-issuance true \
  --query appId -o tsv)
echo "AppId: $APP_ID"
```

3. Create a client secret:

```bash
AAD_SECRET=$(az ad app credential reset \
  --id $APP_ID \
  --display-name "swa-disk-calc" \
  --query password -o tsv)
```

4. Add the AAD credentials to the SWA app settings:

```bash
az staticwebapp appsettings set \
  --name swa-disk-calculator \
  --resource-group $RG \
  --setting-names \
    "AAD_CLIENT_ID=$APP_ID" \
    "AAD_CLIENT_SECRET=$AAD_SECRET"
```

5. Patch `staticwebapp.config.json` in your repo with the tenant ID, then push:

```bash
sed -i.bak "s/<YOUR_TENANT_ID>/$TENANT_ID/" staticwebapp.config.json
rm staticwebapp.config.json.bak
git commit -am "Wire Entra ID tenant"
git push
```

GitHub Actions redeploys in ~1 minute.

## Phase 6 — Smoke-test cloud sync

1. Open `https://$SWA_HOST` in a fresh browser session. The header shows a **Sign in to sync** button.
2. Click it. Sign in with a BBB tenant account. You're redirected back; the header now shows your email.
3. Open Saved Scenarios. Type a name (e.g. "Test"), click Save. The row appears.
4. Open the same URL in a different browser (or incognito). Sign in with the same account. The "Test" scenario shows up — that's Cosmos doing its job.
5. Open the Cosmos DB Data Explorer in the Azure portal to confirm the document landed in `saved-scenarios`.

## Common gotchas

| Symptom | Fix |
|---|---|
| Build fails: "could not find output folder" | Leave the SWA Output location empty. There's no build step for plain HTML. |
| `/api/scenarios` returns 401 even when signed in | Double-check `AAD_CLIENT_ID` and `AAD_CLIENT_SECRET` are set as SWA app settings, and that `<YOUR_TENANT_ID>` got replaced in `staticwebapp.config.json`. |
| Function 500: "Missing COSMOS_ENDPOINT" | App settings missed. Re-run the `az staticwebapp appsettings set` command in Phase 4. |
| Scenarios on one device don't appear on another | Confirm both sessions signed in as the same Entra account. Each `userId` gets its own scenario list (by partition). |
| GitHub Action build fails on `api/package.json` | The pipeline runs `npm install` in `/api`. If `package.json` is malformed it fails — check the Actions tab. |
| Free tier already in use | Cosmos free tier is one per Azure subscription. Drop `--enable-free-tier true` and use plain serverless instead (~$0.25 per million RU, still pennies for this workload). |

## Customizations

**Custom domain** (e.g. `disk.bitxbit.com`):

```bash
az staticwebapp hostname set \
  --name swa-disk-calculator \
  --resource-group $RG \
  --hostname disk.bitxbit.com
```

Add a CNAME at your DNS provider pointing to `$SWA_HOST`. Update the Entra ID app redirect URI to use the new hostname.

**Lock the whole site to authenticated users** (remove the anonymous-fallback mode): in `staticwebapp.config.json`, add a wildcard route:

```json
{ "route": "/*", "allowedRoles": ["authenticated"] }
```

**Migrate to managed identity** (so secrets disappear from app settings):

1. Enable a system-assigned managed identity on the SWA.
2. Grant it the `Cosmos DB Built-in Data Contributor` role on the Cosmos account.
3. In `api/scenarios/index.js`, swap `new CosmosClient({ endpoint, key })` for the AAD-credential pattern using `DefaultAzureCredential` from `@azure/identity`.
4. Remove `COSMOS_KEY` from the SWA settings.

**Shared team scenarios** (everyone sees the same list): change the partition key strategy. Use a fixed value like `/teamId` and add a "shared" flag to documents. The Function adjusts its query to include team-shared rows.

---

## Cost estimate

For a BBB-internal tool with ~50 users syncing scenarios occasionally:

- **Static Web Apps Free tier:** $0 (100GB bandwidth, 250MB app size, 2 custom domains, free SSL)
- **Cosmos DB free tier:** $0 (1000 RU/s + 25GB free forever, one account per subscription)
- **Entra ID:** $0 for tenant authentication
- **Total:** **$0/month** as long as you stay inside the free tiers — which you will for this workload.

If the free tier is already claimed elsewhere, expect Cosmos serverless to run roughly $1–3/month for this use case.
#   D i s k - C a l c u l a t o r  
 #   d i s k - c a l c - a z u r e  
 