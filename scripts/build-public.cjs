// Builds ./dist: the files that are published to Cloudflare Pages.
// Internal docs, worker source/config and tests stay in the repository but are not deployed.
// Usage: node scripts/build-public.cjs && npx wrangler pages deploy dist --project-name=karma --branch=main
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const excluded = [
  /^\.git(\/|$)/, /^\.github(\/|$)/, /^\.wrangler(\/|$)/, /^node_modules(\/|$)/, /^dist(\/|$)/,
  /^scripts(\/|$)/, /^tests(\/|$)/,
  /^assets\/js\/worker\.js$/,
  /^wrangler\.toml$/, /^package(?:-lock)?\.json$/, /^validate-[^/]+\.js$/,
  /^[^/]+\.md$/, /^tmp-server-.*\.log$/, /^npm-debug\.log/
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (excluded.some(pattern => pattern.test(rel))) continue;
    if (entry.isDirectory()) walk(rel, files);
    else files.push(rel);
  }
  return files;
}

fs.rmSync(output, { recursive: true, force: true });
const files = walk('');
for (const rel of files) {
  fs.mkdirSync(path.dirname(path.join(output, rel)), { recursive: true });
  fs.copyFileSync(path.join(root, rel), path.join(output, rel));
}
console.log(`Built dist with ${files.length} public files`);
