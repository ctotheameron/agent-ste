/**
 * Decides which text in a file the linter may see.
 *
 * Every function here returns a string of the SAME line count as its input, and
 * blanks the rest. The Gleam engine then reports a line number that matches the
 * real file, with no offset arithmetic in the host.
 */

const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst"]);

const LINE_COMMENT = {
  ".ts": "//",
  ".tsx": "//",
  ".js": "//",
  ".mjs": "//",
  ".cjs": "//",
  ".jsx": "//",
  ".gleam": "//",
  ".go": "//",
  ".rs": "//",
  ".swift": "//",
  ".kt": "//",
  ".java": "//",
  ".c": "//",
  ".h": "//",
  ".cpp": "//",
  ".sh": "#",
  ".bash": "#",
  ".zsh": "#",
  ".py": "#",
  ".rb": "#",
  ".yml": "#",
  ".yaml": "#",
  ".toml": "#",
  ".just": "#",
};

function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function blank(text) {
  return " ".repeat(text.length);
}

/**
 * Finds the column of a real comment marker, or -1 when the line holds none.
 *
 * `https://example.com` holds `//` and starts no comment. A colon in front of
 * the marker names a scheme, so the search moves past it and tries again.
 */
function markerColumn(line, marker) {
  let at = line.indexOf(marker);
  while (at > 0 && line[at - 1] === ":") {
    at = line.indexOf(marker, at + marker.length);
  }
  return at;
}

/** The count of quote characters that no backslash escapes. */
function quoteCount(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

/**
 * Keeps only `//` or `#` comment bodies. Everything else becomes spaces.
 *
 * A template literal spans lines, and its text often holds a URL or a word the
 * rules ban. So this tracks an open backtick across lines and blanks the text
 * inside it. A quote on the same line still uses a count, which is crude, and
 * which needs no parser.
 */
function commentsOnly(content, marker) {
  const tracksTemplate = marker === "//";
  let inTemplate = false;

  return content
    .split("\n")
    .map((line) => {
      const opened = inTemplate;
      if (tracksTemplate && quoteCount(line, /(?<!\\)`/g) % 2 !== 0) {
        inTemplate = !inTemplate;
      }
      if (opened) {
        return blank(line);
      }

      const at = markerColumn(line, marker);
      if (at === -1) {
        return blank(line);
      }
      // A marker inside a string literal is not a comment. Counting unescaped
      // quotes before it is crude but it avoids a full parser.
      const before = line.slice(0, at);
      if (quoteCount(before, /(?<!\\)["'`]/g) % 2 !== 0) {
        return blank(line);
      }
      return blank(before) + " ".repeat(marker.length) + line.slice(at + marker.length);
    })
    .join("\n");
}

/** Keeps only the inside of `/* ... *\/` blocks. */
function blockCommentsOnly(content) {
  const lines = content.split("\n");
  const kept = [];
  let inside = false;
  // Build these markers by concatenation, so no bare literal trips this scan.
  const open = "/" + "*";
  const close = "*" + "/";
  for (const line of lines) {
    const opens = line.includes(open);
    const closes = line.includes(close);
    if (inside || opens) {
      kept.push(line.replace(/\/\*|\*\/|^\s*\*/g, (m) => " ".repeat(m.length)));
      inside = opens ? !closes : !closes;
    } else {
      kept.push(blank(line));
    }
  }
  return kept.join("\n");
}

function mergeMasks(left, right) {
  const a = left.split("\n");
  const b = right.split("\n");
  return a
    .map((line, index) => {
      const other = b[index] ?? "";
      return [...line]
        .map((character, column) =>
          character !== " " ? character : (other[column] ?? " "),
        )
        .join("");
    })
    .join("\n");
}

/**
 * Returns the lintable view of a file, or undefined when the file has none.
 */
export function lintableText(path, content) {
  const extension = extensionOf(path);
  if (PROSE_EXTENSIONS.has(extension)) {
    return content;
  }
  const marker = LINE_COMMENT[extension];
  if (!marker) {
    return undefined;
  }
  const line = commentsOnly(content, marker);
  return marker === "//" ? mergeMasks(line, blockCommentsOnly(content)) : line;
}

// Every way a message reaches `git commit`, except a file path. A quoted value
// wins, and a bare word is the fallback.
//
// `-[a-z]*m` catches a combined short flag such as `-am`. A long flag starts
// with two dashes, so the leading `(^|\s)-` cannot match it by mistake.
const SHORT_FLAG =
  /(?:^|\s)-[a-zA-Z]*m[ \t]*(?:(['"])([\s\S]*?)\1|([^\s'"][^\s]*))/g;
const LONG_FLAG =
  /--message(?:=|[ \t]+)(?:(['"])([\s\S]*?)\1|([^\s'"][^\s]*))/g;
const HEREDOC = /-F\s*-[^\n]*\n<<['"]?(\w+)['"]?\n([\s\S]*?)\n\1/;

/**
 * True when a value reads as prose rather than as a token.
 *
 * `-m` carries a commit message, and it also carries a file mode. `mkdir -m
 * 755` and `install -m 0644` must stay unread, so a value needs two words with
 * a letter in them, and one lowercase letter. A value this test rejects stays
 * unread, which also covers `-m "$MESSAGE"`.
 */
function readsAsProse(value) {
  const words = value.trim().split(/\s+/).filter((word) => /[a-zA-Z]/.test(word));
  return words.length >= 2 && /[a-z]/.test(value);
}

/**
 * Every message a bash command carries, whatever the command is.
 *
 * `git commit` is not the only command that sends prose to a person. A harness
 * posts a message with its own tool, and `-m` or `--message` names the text.
 * So the reader takes any such value that reads as prose.
 *
 * This covers a flag only. A body in a file stays unread. So do a heredoc that
 * writes a document, and a payload in JSON.
 */
export function bashMessage(command) {
  const found = [];
  for (const pattern of [SHORT_FLAG, LONG_FLAG]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(command);
    while (match) {
      const value = match[2] ?? match[3];
      if (value !== undefined && readsAsProse(value)) {
        found.push(value);
      }
      match = pattern.exec(command);
    }
  }

  const heredoc = command.match(HEREDOC);
  if (heredoc) {
    found.push(heredoc[2]);
  }

  const text = found.join("\n\n");
  return text.trim() === "" ? undefined : text;
}

/** The name for a message, so a block reason says where the text came from. */
export function bashMessageLabel(command) {
  return COMMIT_VERB.test(command) ? "the commit message" : "the message";
}

// `git commit`, and also `git -C /tmp commit`. A global flag can sit between the
// two words. A shell separator ends the search, so a later command is safe.
const COMMIT_VERB = /git\s+(?:[^\s;|&]+\s+)*?commit\b/;

/** Extracts every `git commit` message from a bash command, if there is one. */
export function commitMessage(command) {
  const at = command.search(COMMIT_VERB);
  if (at === -1) {
    return undefined;
  }
  const tail = command.slice(at);

  const found = [];
  for (const pattern of [SHORT_FLAG, LONG_FLAG]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(tail);
    while (match) {
      found.push(match[2] ?? match[3]);
      match = pattern.exec(tail);
    }
  }

  const heredoc = tail.match(HEREDOC);
  if (heredoc) {
    found.push(heredoc[2]);
  }

  // `git commit -m a -m b` makes one message of two paragraphs.
  const text = found.filter((part) => part !== undefined).join("\n\n");
  return text.trim() === "" ? undefined : text;
}
