const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  bgDark: "\x1b[48;5;235m",
};

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "class", "extends", "new",
  "this", "super", "import", "export", "from", "default", "async", "await",
  "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of",
  "true", "false", "null", "undefined", "void", "delete", "yield", "static",
  "get", "set", "constructor",
]);

const DART_KEYWORDS = new Set([
  "import", "export", "class", "extends", "implements", "with", "abstract",
  "static", "final", "const", "var", "late", "dynamic", "void", "null",
  "true", "false", "new", "this", "super", "if", "else", "for", "while",
  "do", "switch", "case", "break", "continue", "return", "try", "catch",
  "finally", "throw", "async", "await", "yield", "get", "set", "factory",
  "required", "enum", "mixin", "extension", "typedef",
]);

const PYTHON_KEYWORDS = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "break",
  "continue", "import", "from", "as", "try", "except", "finally", "raise",
  "with", "yield", "lambda", "pass", "del", "global", "nonlocal", "assert",
  "True", "False", "None", "and", "or", "not", "in", "is", "self", "async",
  "await",
]);

const GO_KEYWORDS = new Set([
  "func", "package", "import", "return", "if", "else", "for", "range",
  "switch", "case", "default", "break", "continue", "go", "chan", "select",
  "defer", "var", "const", "type", "struct", "interface", "map", "make",
  "new", "true", "false", "nil",
]);

const RUST_KEYWORDS = new Set([
  "fn", "let", "mut", "const", "struct", "enum", "impl", "trait", "pub",
  "use", "mod", "crate", "self", "super", "return", "if", "else", "for",
  "while", "loop", "match", "break", "continue", "move", "ref", "async",
  "await", "true", "false", "Self",
]);

function getKeywords(lang: string): Set<string> {
  switch (lang) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx":
      return JS_KEYWORDS;
    case "dart":
      return DART_KEYWORDS;
    case "python":
    case "py":
      return PYTHON_KEYWORDS;
    case "go":
      return GO_KEYWORDS;
    case "rust":
    case "rs":
      return RUST_KEYWORDS;
    default:
      return JS_KEYWORDS;
  }
}

function highlightCode(code: string, lang: string): string {
  const keywords = getKeywords(lang);
  const lines = code.split("\n");

  return lines
    .map((line) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("#")) {
        return `${ANSI.dim}${line}${ANSI.reset}`;
      }

      return line
        .replace(
          /(\/\/.*$|#.*$)/m,
          `${ANSI.dim}$1${ANSI.reset}`
        )
        .replace(
          /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,
          `${ANSI.green}$1${ANSI.reset}`
        )
        .replace(
          /\b(\d+\.?\d*)\b/g,
          `${ANSI.magenta}$1${ANSI.reset}`
        )
        .replace(
          /\b([A-Z][a-zA-Z0-9]*)\b/g,
          `${ANSI.yellow}$1${ANSI.reset}`
        )
        .replace(
          new RegExp(`\\b(${Array.from(keywords).join("|")})\\b`, "g"),
          `${ANSI.cyan}$1${ANSI.reset}`
        );
    })
    .join("\n");
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  ts: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  js: "JavaScript",
  jsx: "JSX",
  dart: "Dart",
  python: "Python",
  py: "Python",
  go: "Go",
  rust: "Rust",
  rs: "Rust",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  markdown: "Markdown",
  md: "Markdown",
};

export function highlightMarkdown(text: string): string {
  const CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;

  return text.replace(CODE_BLOCK_REGEX, (_match, lang: string, code: string) => {
    const displayLang = LANGUAGE_LABELS[lang] || lang || "Code";
    const header = `${ANSI.bgDark}${ANSI.bold}  ${displayLang}  ${ANSI.reset}`;
    const highlighted = highlightCode(code.trimEnd(), lang || "typescript");
    return `${header}\n${highlighted}\n${ANSI.reset}`;
  });
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
