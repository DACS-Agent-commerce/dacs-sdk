// An in-memory model of the file operations the evidence publisher uses.
//
// Every directory has a visible namespace (what a running process sees) and a durable one (what
// survives power loss). `link`, `unlink` and `mkdir` change only the visible namespace; a directory
// `fsync` copies it to the durable one. A file `fsync` makes the file's content durable. A file whose
// name is durable but whose content was never synchronized comes back empty.
import { posix } from "node:path";

function fileNode() {
  return { kind: "file", content: Buffer.alloc(0), durableContent: Buffer.alloc(0) };
}

function directoryNode() {
  return { kind: "dir", visible: new Map(), durable: new Map() };
}

function failure(code, path) {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** Creates a model. `intercept(operation, path, details)` runs before every operation and may
 * await, throw, or call `kill()`. `operations` records every operation in order. */
export function createEvidenceFsModel() {
  const root = directoryNode();
  const operations = [];
  let dead;
  const model = { operations, intercept: undefined };

  function resolveDirectory(path) {
    let node = root;
    for (const part of path.split("/").filter(Boolean)) {
      node = node.kind === "dir" ? node.visible.get(part) : undefined;
      if (node === undefined) throw failure("ENOENT", path);
    }
    if (node.kind !== "dir") throw failure("ENOTDIR", path);
    return node;
  }

  function split(path) {
    return { directory: resolveDirectory(posix.dirname(path)), name: posix.basename(path) };
  }

  function lookup(path) {
    if (path === "/") return root;
    const { directory, name } = split(path);
    const node = directory.visible.get(name);
    if (node === undefined) throw failure("ENOENT", path);
    return node;
  }

  async function operation(name, path, run, details = {}) {
    if (dead) throw dead;
    operations.push({ operation: name, path, ...details });
    if (model.intercept !== undefined) await model.intercept(name, path, details);
    if (dead) throw dead;
    return run();
  }

  /** Marks the process dead: every later operation fails. Returns the error to throw. */
  model.kill = () => { dead = new Error("process killed"); return dead; };
  /** Starts a new process on the same visible state. */
  model.restart = () => { dead = undefined; };
  /** Keeps only what was synchronized, then starts a new process. */
  model.powerLoss = () => {
    const keepDurable = (directory) => {
      directory.visible = new Map(directory.durable);
      for (const node of directory.visible.values()) {
        if (node.kind === "dir") keepDurable(node);
        else node.content = Buffer.from(node.durableContent);
      }
    };
    keepDurable(root);
    dead = undefined;
  };

  /** Creates a directory (and its parents) that is already durable. */
  model.seedDirectory = (path) => {
    let directory = root;
    for (const part of path.split("/").filter(Boolean)) {
      let next = directory.visible.get(part);
      if (next === undefined) {
        next = directoryNode();
        directory.visible.set(part, next);
        directory.durable.set(part, next);
      }
      directory = next;
    }
  };
  model.listVisible = (path) => [...resolveDirectory(path).visible.keys()].sort();
  model.listDurable = (path) => [...resolveDirectory(path).durable.keys()].sort();
  model.read = (path) => Buffer.from(lookup(path).content);
  model.readDurable = (path) => Buffer.from(lookup(path).durableContent);
  /** Puts a finished file in the visible and the durable namespace. */
  model.seedFile = (path, bytes) => {
    const { directory, name } = split(path);
    const node = fileNode();
    node.content = Buffer.from(bytes);
    node.durableContent = Buffer.from(bytes);
    directory.visible.set(name, node);
    directory.durable.set(name, node);
  };

  model.fs = {
    open: (path, flags) => operation("open", path, () => {
      if (flags === "wx") {
        const { directory, name } = split(path);
        if (directory.visible.has(name)) throw failure("EEXIST", path);
        const node = fileNode();
        directory.visible.set(name, node);
        return { path, node, close: async () => {} };
      }
      return { path, node: lookup(path), close: async () => {} };
    }, { flags }),
    write: (handle, bytes) => operation("write", handle.path, () => {
      handle.node.content = Buffer.concat([handle.node.content, bytes]);
    }),
    fsync: (handle) => operation("fsync", handle.path, () => {
      if (handle.node.kind === "dir") handle.node.durable = new Map(handle.node.visible);
      else handle.node.durableContent = Buffer.from(handle.node.content);
    }),
    link: (existing, path) => operation("link", path, () => {
      const node = lookup(existing);
      const { directory, name } = split(path);
      if (directory.visible.has(name)) throw failure("EEXIST", path);
      directory.visible.set(name, node);
    }, { existing }),
    unlink: (path) => operation("unlink", path, () => {
      const { directory, name } = split(path);
      if (!directory.visible.delete(name)) throw failure("ENOENT", path);
    }),
    mkdir: (path) => operation("mkdir", path, () => {
      const { directory, name } = split(path);
      if (directory.visible.has(name)) throw failure("EEXIST", path);
      directory.visible.set(name, directoryNode());
    }),
    readFile: (path, limit) => operation("readFile", path, () => {
      const node = lookup(path);
      if (node.kind !== "file") throw failure("EISDIR", path);
      return Buffer.from(node.content.subarray(0, limit));
    }, { limit }),
  };
  return model;
}
