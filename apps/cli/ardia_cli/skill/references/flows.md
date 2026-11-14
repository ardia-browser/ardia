# Saved flows

A flow turns a task you did once in the page (a search, a filtered list, a lookup) into one call that returns just
the data. The session records every action with the first-party JSON it loaded; nothing needs turning on.

```sh
ardia browse open https://shop.example.com/search
ardia browse fill "#q" kettle
ardia browse click "#go"
ardia browse flow steps                      # what each step loaded: s3r1 GET …/api/search?q=kettle 200 json
ardia browse flow save search --description "Search the shop"
ardia browse flow run search --param q=toaster --fields title,price --limit 5
```

- `flow save <name>` saves the steps since the last save, from the last `open`. Typed text and URL query values the
  requests sent become params, named after the field (`--param name=value` names one and keeps it as the example).
  `--from`/`--to` pick other steps, `--output s3r1` the request whose answer the flow returns (default: the largest
  that uses a param).
- `flow run` sends that request from a background tab on the site, with the user's logins, and checks the answer
  still has the recorded shape. If it can't, it replays the recorded commands (in a tab that takes input).
- The answer is the main list: `{list, total, matched, items}`. `--fields a,b.c` keeps those fields, `--where f=v`
  keeps items whose field contains v (any case), `--limit n` the first n. An unknown field fails and lists the real
  ones.
- On `open` and `snapshot`, `# saved flows for <site>: name(params) — description` lists a site's flows once per
  session. `flow list`, `flow show <name>`, `flow rm <name>`.

## When it fails

| code | do |
| --- | --- |
| `auth_expired` | ask the user to sign in again in Ardia, then rerun |
| `blocked`, `rate_limited` | wait, or do the task in the page |
| `drifted` | the site changed: do it in the page and `flow save` again |
| `write_not_allowed` | the flow sends a POST or other write: rerun with `--allow-write <id>` only if the user wants it sent |
| `outcome_unknown` | a write may have gone out: check the site before anything else |

Flows never store cookies, auth headers, what was typed into a password, card or code field, or a request body
holding anything but params, small numbers and short words; such a request is left out and the save report says why.
Do that task in the page instead.
