import { createRequire } from "node:module";
import { UsageError } from "./args.ts";
import { ApiError } from "./api.ts";
import { NotLoggedInError } from "./auth.ts";
import { OAuthError } from "./oauth.ts";
import { processContext, type Context } from "./context.ts";
import { AUTH_HELP, runAuth } from "./commands/auth.ts";
import { API_HELP, runApi } from "./commands/api.ts";

const HELP = `bb — Bitbucket Cloud from the command line.

USAGE
  bb <command> <subcommand> [flags]

COMMANDS
  auth    Log in / out of bitbucket.org, print tokens, git credential helper
  api     Make an authenticated REST API request

FLAGS
  --help      Show help for a command
  --verbose   Log HTTP requests to stderr
  --version   Print the version

ENVIRONMENT
  BB_TOKEN          Access token to use instead of the stored login
  BB_GIT_USER       Git username for BB_TOKEN (default derived from the token)
  BB_CONFIG_DIR     Where hosts.yml lives (default $XDG_CONFIG_HOME/bb or ~/.config/bb)
  BB_OAUTH_CLIENT_ID / BB_OAUTH_CLIENT_SECRET
                    Override the OAuth consumer used to refresh tokens
  BB_DEBUG          Same as --verbose

Exit codes: 0 ok · 1 error · 2 usage · 4 not logged in / token rejected
`;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 4;

function version(): string {
  // The single-file bundle has no package.json next to it; scripts/bundle.mjs defines this instead.
  if (process.env.BB_BUNDLED_VERSION) return process.env.BB_BUNDLED_VERSION;
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

export async function main(argv: string[], ctx: Context): Promise<number> {
  const rest = argv.filter((a) => a !== "--verbose");
  const [cmd, ...args] = rest;
  try {
    switch (cmd) {
      case "auth":
        return await runAuth(args, ctx);
      case "api":
        return await runApi(args, ctx);
      case "version":
      case "--version":
        ctx.stdout(`bb ${version()}\n`);
        return EXIT_OK;
      case undefined:
      case "help":
      case "--help":
      case "-h": {
        const topic = args[0];
        ctx.stdout(topic === "auth" ? AUTH_HELP : topic === "api" ? API_HELP : HELP);
        return cmd === undefined ? EXIT_USAGE : EXIT_OK;
      }
      default:
        ctx.stderr(`bb: unknown command "${cmd}"\n\n${HELP}`);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr(`bb: ${err.message}\n`);
      return EXIT_USAGE;
    }
    if (err instanceof NotLoggedInError) {
      ctx.stderr(`bb: ${err.message}\n`);
      return EXIT_AUTH;
    }
    if (err instanceof ApiError) {
      ctx.stderr(`bb: ${err.message}\n`);
      return err.status === 401 ? EXIT_AUTH : EXIT_ERROR;
    }
    if (err instanceof OAuthError) {
      ctx.stderr(`bb: ${err.message}; run \`bb auth login\` again\n`);
      return EXIT_AUTH;
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.stderr(`bb: ${redact(message, ctx.env)}\n`);
    return EXIT_ERROR;
  }
}

/** Belt and braces: never let a token reach stderr through an unexpected error message. */
function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text.replace(/Bearer\s+\S+/g, "Bearer ***").replace(/ATATT[\w=-]+/g, "ATATT***");
  if (env.BB_TOKEN) out = out.split(env.BB_TOKEN).join("***");
  return out;
}

export function runFromProcess(): void {
  const verbose = process.argv.includes("--verbose");
  main(process.argv.slice(2), processContext(verbose)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`bb: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(EXIT_ERROR);
    },
  );
}
