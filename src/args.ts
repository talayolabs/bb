/**
 * Minimal argv parser: `--flag`, `--flag=value`, `--flag value`, `-X value`, `--` terminator.
 * Which flags take a value is declared up front so `bb api -X POST path` and
 * `bb pr create --draft` both parse without ambiguity. Repeated flags accumulate.
 */
export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

export interface FlagSpec {
  /** Flags that take a value; keys are the long names, values are short aliases (or null). */
  valued: Record<string, string | null>;
  /** Boolean flags; same shape. */
  boolean: Record<string, string | null>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const aliases = new Map<string, string>();
  for (const table of [spec.valued, spec.boolean]) {
    for (const [long, short] of Object.entries(table)) if (short) aliases.set(short, long);
  }
  const out: ParsedArgs = { positional: [], flags: new Map() };
  const push = (name: string, value: string) => {
    const list = out.flags.get(name);
    if (list) list.push(value);
    else out.flags.set(name, [value]);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      out.positional.push(arg);
      continue;
    }
    let name: string;
    let inline: string | null = null;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) inline = arg.slice(eq + 1);
    } else {
      const short = arg.slice(1, 2);
      name = aliases.get(short) ?? short;
      if (arg.length > 2) inline = arg.slice(2);
    }
    if (name in spec.boolean) {
      if (inline !== null) throw new UsageError(`flag --${name} does not take a value`);
      push(name, "true");
    } else if (name in spec.valued) {
      if (inline !== null) push(name, inline);
      else {
        const next = argv[i + 1];
        if (next === undefined) throw new UsageError(`flag --${name} needs a value`);
        push(name, next);
        i++;
      }
    } else {
      throw new UsageError(`unknown flag ${arg}`);
    }
  }
  return out;
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const list = args.flags.get(name);
  return list ? list[list.length - 1] : undefined;
}

export function flagAll(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

export function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
