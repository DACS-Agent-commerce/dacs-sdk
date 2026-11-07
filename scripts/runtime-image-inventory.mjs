#!/usr/bin/env node
// Lists every entry under a node_modules tree, nested and scoped, with the
// name and version its package.json records. The registry/container
// acceptance runs it inside the final image (mounted read-only, no
// dependencies) and the disposition compares the list with the lock's
// production closure. A directory whose manifest cannot be read, a file Node
// could still resolve as a module, and a symbolic link are listed without a
// name or version, so the comparison fails closed on each.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const RUNTIME_IMAGE_INVENTORY_SCHEMA = "dacs-runtime-image-inventory/v1";

export function runtimeImageInventory(root) {
  const packages = [];
  const visit = (directory, prefix, scope) => {
    let names;
    try {
      if (lstatSync(directory).isSymbolicLink()) {
        packages.push({ location: prefix, name: null, version: null, link: true });
        return;
      }
      names = readdirSync(directory).sort();
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const path = join(directory, name);
      const location = `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (!scope && name === ".package-lock.json" && stat.isFile()) continue;
      if (!scope && name === ".bin" && stat.isDirectory()) {
        for (const command of readdirSync(path).sort()) {
          const executable = join(path, command);
          const item = { location: `${location}/${command}`, name: null, version: null };
          try {
            if (lstatSync(executable).isSymbolicLink()) {
              item.link = true;
              const target = realpathSync(executable);
              if (lstatSync(target).isFile()) item.target = relative(root, target);
            }
          } catch (error) { item.error = `${error.name}: ${error.message}`; }
          packages.push(item);
        }
        continue;
      }
      if (!scope && name.startsWith("@") && stat.isDirectory()) {
        visit(path, location, true);
        continue;
      }
      if (stat.isSymbolicLink()) {
        packages.push({ location, name: null, version: null, link: true });
        continue;
      }
      if (!stat.isDirectory()) {
        packages.push({ location, name: null, version: null });
        continue;
      }
      let manifest = null;
      let error;
      try { manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")); }
      catch (cause) { error = `${cause.name}: ${cause.message}`; }
      packages.push({ location, name: manifest?.name ?? null, version: manifest?.version ?? null,
        ...(error ? { error } : {}) });
      visit(join(path, "node_modules"), `${location}/node_modules`, false);
    }
  };
  visit(join(root, "node_modules"), "node_modules", false);
  return { schema: RUNTIME_IMAGE_INVENTORY_SCHEMA, packages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(runtimeImageInventory(process.argv[2] ?? "."), null, 2) + "\n");
}
