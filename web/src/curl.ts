import type { HeaderPair } from "./api";

export interface ParsedCurl {
  method: string;
  url: string;
  headers: HeaderPair[];
  body: string;
  bodyEncoding: "utf8" | "base64";
  /** From -u/--user. */
  basicAuth: { username: string; password: string } | null;
  /** Options that were ignored or not supported. */
  warnings: string[];
}

/** Splits a shell command into words, like a POSIX shell, without expansions. */
export function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  const add = (s: string) => (word = (word ?? "") + s);
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\") {
      const next = cmd[++i];
      if (next === "\n" || next === "\r") {
        if (next === "\r" && cmd[i + 1] === "\n") i++;
        continue; // Line continuation.
      }
      if (next !== undefined) add(next);
    } else if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new Error("A single quote is not closed");
      add(cmd.slice(i + 1, end));
      i = end;
    } else if (ch === "$" && cmd[i + 1] === "'") {
      // ANSI-C quoting: $'line\nbreak'
      i += 2;
      let s = "";
      for (; i < cmd.length && cmd[i] !== "'"; i++) {
        if (cmd[i] !== "\\") {
          s += cmd[i];
          continue;
        }
        const e = cmd[++i];
        s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : (e ?? "");
      }
      if (i >= cmd.length) throw new Error("A $' quote is not closed");
      add(s);
    } else if (ch === '"') {
      let s = "";
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        // Inside double quotes, a backslash escapes only these characters.
        if (cmd[i] === "\\" && '"\\$`\n'.includes(cmd[i + 1] ?? "")) {
          if (cmd[++i] !== "\n") s += cmd[i];
        } else {
          s += cmd[i];
        }
      }
      if (i >= cmd.length) throw new Error("A double quote is not closed");
      add(s);
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      add(ch);
    }
  }
  if (word !== null) words.push(word);
  return words;
}

// Options that take a value which this parser does not use.
const IGNORED_WITH_VALUE = new Set([
  "-o", "--output", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "--retry", "--retry-delay",
  "--retry-max-time", "--cacert", "--capath", "-E", "--cert", "--key", "-x", "--proxy", "-U", "--proxy-user",
  "--resolve", "--limit-rate", "-c", "--cookie-jar", "--max-redirs", "--interface", "-K", "--config",
]);

// Short options whose value can follow without a space, e.g. -XPOST.
const SHORT_WITH_VALUE = new Set(["-X", "-H", "-d", "-u", "-b", "-A", "-e", "-F", "-T", "-o", "-m", "-w", "-x"]);

/**
 * Reads a curl command into a request. Also reads the "printf %s '<base64>' | base64 -d | curl ..."
 * form that "Copy as cURL" makes for binary bodies.
 */
export function parseCurl(input: string): ParsedCurl {
  let text = input.trim();
  let pipedBase64: string | null = null;
  const piped = text.match(/^printf\s+%s\s+('[^']*'|"[^"]*"|\S+)\s*\|\s*base64\s+(?:-d|--decode)\s*\|\s*([\s\S]*)$/);
  if (piped) {
    pipedBase64 = shellWords(piped[1]!)[0] ?? "";
    text = piped[2]!;
  }

  const words = shellWords(text);
  if (words[0] !== "curl") throw new Error("The command must start with curl");

  const result: ParsedCurl = {
    method: "",
    url: "",
    headers: [],
    body: "",
    bodyEncoding: "utf8",
    basicAuth: null,
    warnings: [],
  };
  const data: string[] = [];
  let formEncoded = false;
  let json = false;
  let get = false;

  for (let i = 1; i < words.length; i++) {
    let opt = words[i]!;
    let value: string | undefined;
    const eq = opt.startsWith("--") ? opt.indexOf("=") : -1;
    if (eq !== -1) {
      value = opt.slice(eq + 1);
      opt = opt.slice(0, eq);
    } else if (/^-[A-Za-z]./.test(opt) && SHORT_WITH_VALUE.has(opt.slice(0, 2))) {
      value = opt.slice(2);
      opt = opt.slice(0, 2);
    }
    const next = () => {
      if (value !== undefined) return value;
      const v = words[++i];
      if (v === undefined) throw new Error(`${opt} needs a value`);
      return v;
    };

    switch (opt) {
      case "-X":
      case "--request":
        result.method = next().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = next();
        const colon = h.indexOf(":");
        if (colon > 0) result.headers.push([h.slice(0, colon).trim(), h.slice(colon + 1).trim()]);
        break;
      }
      case "-d":
      case "--data":
      case "--data-ascii":
      case "--data-raw":
      case "--data-binary": {
        const d = next();
        if (d === "@-" && pipedBase64 !== null) {
          result.body = pipedBase64;
          result.bodyEncoding = "base64";
        } else if (d.startsWith("@") && opt !== "--data-raw") {
          result.warnings.push(`Cannot read the file ${d.slice(1)}; add the body by hand`);
        } else {
          data.push(d);
        }
        formEncoded = true;
        break;
      }
      case "--data-urlencode": {
        const d = next();
        const at = d.indexOf("=");
        data.push(at === -1 ? encodeURIComponent(d) : `${d.slice(0, at)}=${encodeURIComponent(d.slice(at + 1))}`);
        formEncoded = true;
        break;
      }
      case "--json":
        data.push(next());
        json = true;
        break;
      case "-u":
      case "--user": {
        const u = next();
        const colon = u.indexOf(":");
        result.basicAuth = colon === -1 ? { username: u, password: "" } : { username: u.slice(0, colon), password: u.slice(colon + 1) };
        break;
      }
      case "-b":
      case "--cookie": {
        const c = next();
        if (c.includes("=")) result.headers.push(["Cookie", c]);
        else result.warnings.push(`Cannot read the cookie file ${c}`);
        break;
      }
      case "-A":
      case "--user-agent":
        result.headers.push(["User-Agent", next()]);
        break;
      case "-e":
      case "--referer":
        result.headers.push(["Referer", next()]);
        break;
      case "-I":
      case "--head":
        result.method = "HEAD";
        break;
      case "-G":
      case "--get":
        get = true;
        break;
      case "--url":
        result.url = next();
        break;
      case "-F":
      case "--form":
        next();
        result.warnings.push("Multipart -F/--form fields are not supported");
        break;
      case "-T":
      case "--upload-file":
        result.warnings.push(`Cannot read the file ${next()}`);
        break;
      default:
        if (IGNORED_WITH_VALUE.has(opt)) next();
        else if (!opt.startsWith("-")) result.url ||= opt;
      // Other options, such as -s, -L, -k or --compressed, do not change the request.
    }
  }

  if (!result.url) throw new Error("The command has no URL");
  // curl uses http:// when the URL has no scheme. A URL that starts with a {{variable}} stays as it is.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(result.url) && !result.url.startsWith("{{")) {
    result.url = `http://${result.url}`;
  }

  const has = (name: string) => result.headers.some(([k]) => k.toLowerCase() === name);
  if (data.length && get) {
    const query = data.join("&");
    result.url += (result.url.includes("?") ? "&" : "?") + query;
  } else if (data.length) {
    result.body = data.join("&");
    if (json) {
      if (!has("content-type")) result.headers.push(["Content-Type", "application/json"]);
      if (!has("accept")) result.headers.push(["Accept", "application/json"]);
    } else if (formEncoded && !has("content-type")) {
      // curl sends -d data as a form unless a Content-Type is given.
      result.headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    }
  }
  result.method ||= get ? "GET" : result.body ? "POST" : "GET";
  return result;
}
