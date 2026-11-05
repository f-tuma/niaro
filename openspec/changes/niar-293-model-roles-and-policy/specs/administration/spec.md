# Spec Delta

## MODIFIED Requirements

### Requirement: Console navigation

The console sidebar SHALL show the workspace switcher at the top, **Overview** first, then the groups **Services** (Services, Installed connectors, Built-in tools, External AI apps), **AI** (AI providers, Models, Usage limits, Skills), **Processes** (Processes, Runs), **People** (People, Workspaces, Sign-in methods) and **Settings** (Activity log, Settings), and the account menu (theme, language, sign out) at the bottom.

#### Scenario: Administrator opens the console

- **WHEN** an administrator opens `/admin/`
- **THEN** the sidebar shows the groups and items above in that order and the Overview page is selected

#### Scenario: Switching workspace

- **WHEN** an administrator chooses another workspace in the switcher
- **THEN** workspace-scoped pages show that workspace's services, models, processes and runs

### Requirement: Console pages and owners

Each console item SHALL open its page, specified by the named capability: Services `/admin/services` (`service-catalog`), Installed connectors `/admin/hosted` (`hosted-mcp-servers`), Built-in tools `/admin/plugins` (`plugins`), External AI apps `/admin/mcp` (`mcp-server`), AI providers and Models (`models-and-providers`), Usage limits (`inference-budget`), Skills (`skills`), Processes (`process-definitions`), People, Workspaces, Sign-in methods and Activity log (`identity-access`).

#### Scenario: Open Model choice

- **WHEN** an administrator selects Models, the former Model choice, in the sidebar
- **THEN** the address becomes `/admin/routing` and the model policy of the organization and the selected workspace is shown

### Requirement: Console addresses

The console pages SHALL have these addresses: AI providers `/admin/providers`, Models `/admin/routing`, Usage limits `/admin/usage`, Skills `/admin/skills`, Processes `/admin/processes`, Runs `/admin/loops`, People `/admin/people`, Workspaces `/admin/workspaces`, Sign-in methods `/admin/auth-providers`, Activity log `/admin/audit` and Settings `/admin/settings`.

#### Scenario: Direct link to Runs

- **WHEN** an administrator opens `/admin/loops` directly
- **THEN** the Runs page opens with Runs selected in the sidebar

### Requirement: Overview checklist

For owners and administrators the Overview SHALL show a first-run checklist with progress, each step linking to its page: (1) an enabled provider with a key; (2) an enabled model of such a provider; (3) a chat model, the workspace's own or inherited; (4) usage limits in enforce mode with a current price for that model (see `inference-budget`); (5) an enabled service with an action granted to a role or person; (6) another member or a pending invitation. It SHALL disappear once all steps are done.

#### Scenario: New installation

- **WHEN** the owner opens the Overview right after setup
- **THEN** the checklist shows 0 of 6 with the provider step as the next one, linking to AI providers

#### Scenario: Price out of date

- **WHEN** the chat model's price was set before the model or its provider was last edited
- **THEN** the usage-limits step is not done

#### Scenario: Everything set up

- **WHEN** all six steps are done
- **THEN** the Overview shows no checklist

#### Scenario: Inherited chat model

- **WHEN** a workspace sets no chat model and the organization default has one
- **THEN** the chat model step is done

### Requirement: Run detail

The run detail (`GET /admin/api/identity/loops/<64-hex id>?organizationId=…`) SHALL show the run's request, reply, status, provenance and its steps as a timeline in recorded order (model calls with their model, role and reason, checks, internal tools, service reads and writes), marked as recorded or reconstructed. A trace SHALL hold at most 160 nodes and 320 edges with explicit truncation. Opening a run SHALL never repeat any of its actions.

#### Scenario: Inspect a failed write

- **WHEN** an administrator opens a run whose CRM write failed with a validation error
- **THEN** the step shows the action, its bounded inputs, the recorded cause and field issues, and a next step, without the provider's raw response

#### Scenario: Server restarted mid-run

- **WHEN** the server restarted while a run was running
- **THEN** the run is shown as `interrupted` and none of its actions is executed again

#### Scenario: Escalated step

- **WHEN** an administrator opens a run whose write was rejected and escalated
- **THEN** the next model step names the escalation model, role Escalation and reason "Escalated after a rejected write"
