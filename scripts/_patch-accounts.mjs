import fs from "fs";

const p =
  "E:/Work/OllamaCode/.cache/vscode/src/vs/workbench/browser/parts/globalCompositeBar.ts";
let s = fs.readFileSync(p, "utf8");
if (s.includes("OLLAMACODE_ACCOUNTS_FILTER")) {
  console.log("already patched");
  process.exit(0);
}
const re =
  /otherCommands\.forEach\(\(group, i\) => \{\r?\n\t\t\tconst actions = group\[1\];\r?\n\t\t\tmenus = menus\.concat\(actions\);\r?\n\t\t\tif \(i !== otherCommands\.length - 1\) \{\r?\n\t\t\t\tmenus\.push\(new Separator\(\)\);\r?\n\t\t\t\}\r?\n\t\t\}\);/;
if (!re.test(s)) {
  const i = s.indexOf("otherCommands.forEach");
  console.log("no match", JSON.stringify(s.slice(i, i + 250)));
  process.exit(1);
}
s = s.replace(
  re,
  `otherCommands.forEach((group, i) => {
			// OLLAMACODE_ACCOUNTS_FILTER
			const actions = group[1].filter(a => {
				const id = (a.id || '').toLowerCase();
				const label = (a.label || '').toLowerCase();
				return !/sync|tunnel|copilot|chatgpt|openai|backup and sync|cloud changes|remote tunnel/.test(id + ' ' + label);
			});
			if (!actions.length) {
				return;
			}
			menus = menus.concat(actions);
			if (i !== otherCommands.length - 1) {
				menus.push(new Separator());
			}
		});`
);
fs.writeFileSync(p, s);
console.log("patched accounts");
