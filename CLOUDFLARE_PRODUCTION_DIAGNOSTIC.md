# SEISEKI Cloudflare production diagnostic

Generated automatically from GitHub Actions.

```text
## wrangler whoami

 ⛅️ wrangler 4.125.0
────────────────────
Getting User settings...
👋 You are logged in with an User API Token. Unable to retrieve email for this user. Are you missing the `User->User Details->Read` permission?
ℹ️  The API Token is read from the CLOUDFLARE_API_TOKEN environment variable.
┌───────────────┬──────────────────────────────────┐
│ Account Name  │ Account ID                       │
├───────────────┼──────────────────────────────────┤
│ tokyo_odh_129 │ 5d1a16ce92c25012e162a15bf75a3609 │
└───────────────┴──────────────────────────────────┘
🔓 To see token permissions visit https://dash.cloudflare.com/profile/api-tokens
whoami_exit=0

## d1 list

[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mA request to the Cloudflare API (/accounts/5d1a16ce92c25012e162a15bf75a3609/d1/database) failed.[0m

  Authentication error [code: 10000]


📎 It looks like you are authenticating Wrangler via a custom API token set in an environment variable.
Please ensure it has the correct permissions for this operation.

Getting User settings...
👋 You are logged in with an User API Token. Unable to retrieve email for this user. Are you missing the `User->User Details->Read` permission?
ℹ️  The API Token is read from the CLOUDFLARE_API_TOKEN environment variable.
┌───────────────┬──────────────────────────────────┐
│ Account Name  │ Account ID                       │
├───────────────┼──────────────────────────────────┤
│ tokyo_odh_129 │ 5d1a16ce92c25012e162a15bf75a3609 │
└───────────────┴──────────────────────────────────┘
🔓 To see token permissions visit https://dash.cloudflare.com/profile/api-tokens
🎢 Unable to get membership roles. Make sure you have permissions to read the account. Are you missing the `User->Memberships->Read` permission?
🪵  Logs were written to "/home/runner/.config/.wrangler/logs/wrangler-2026-08-23_07-05-41_535.log"
d1_list_exit=1

## queues list

 ⛅️ wrangler 4.125.0
────────────────────
┌──────────────────────────────────┬──────────────────────────┬─────────────────────────────┬─────────────────────────────┬───────────┬───────────┐
│ id                               │ name                     │ created_on                  │ modified_on                 │ producers │ consumers │
├──────────────────────────────────┼──────────────────────────┼─────────────────────────────┼─────────────────────────────┼───────────┼───────────┤
│ c9d19875953446938c0a0a1b4ce68a4d │ seiseki-analysis-staging │ 2026-08-12T03:20:52.915265Z │ 2026-08-12T03:20:52.915265Z │ 1         │ 1         │
└──────────────────────────────────┴──────────────────────────┴─────────────────────────────┴─────────────────────────────┴───────────┴───────────┘
queues_list_exit=0

## deployments list

 ⛅️ wrangler 4.125.0
────────────────────

[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mA request to the Cloudflare API (/accounts/5d1a16ce92c25012e162a15bf75a3609/workers/scripts/seiseki-api/deployments) failed.[0m

  This Worker does not exist on your account. [code: 10007]
  
  If you think this is a bug, please open an issue at: [4mhttps://github.com/cloudflare/workers-sdk/issues/new/choose[0m


🪵  Logs were written to "/home/runner/.config/.wrangler/logs/wrangler-2026-08-23_07-05-45_679.log"
deployments_list_exit=1
```
