/** Match a complete repository-relative path; only ** crosses directory boundaries. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        pattern += "(?:.*/)?";
        i++;
      } else {
        pattern += ".*";
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(glob => globToRegExp(glob).test(path));
}
