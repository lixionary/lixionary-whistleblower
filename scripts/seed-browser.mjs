import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const file = ".suite-dev/suite.env",
  env = await readFile(file, "utf8");
if (!env.includes("SUITE_NODE_ENV=development"))
  throw new Error("Browser seed is limited to development");
const code = `import postgres from 'postgres'; import {randomUUID} from 'node:crypto'; import {hashSecret} from '@whistle/runtime'; import {defaultSettings} from '@whistle/shared'; const db=postgres(process.env.MIGRATION_DATABASE_URL,{max:1,onnotice:()=>{}}); try { await db.begin(async tx=>{const existing=await tx\`select email from staff\`;if(existing.some(s=>!s.email.startsWith('e2e-')))throw new Error('Non-test staff present; refusing seed');const roles=[['admin','admin'],['manager','manager'],['manager2','manager'],['analyst','analyst'],['independent','manager'],['independent2','manager']];const ids={};for(const [name,role] of roles){const row=await tx\`insert into staff(email,name,role,password_hash) values(\${'e2e-'+name+'@example.test'},\${'E2E '+name},\${role},\${await hashSecret('UI test-only long password')}) on conflict(email) do update set active=true,mfa_enc=null,mfa_pending_enc=null,mfa_last_step=null returning id\`;ids[name]=row[0].id;}const normal=await tx\`insert into teams(name,restricted) values('E2E Standard',false) on conflict(name) do update set restricted=false returning id\`;const restricted=await tx\`insert into teams(name,restricted) values('E2E Independent',true) on conflict(name) do update set restricted=true returning id\`;for(const name of ['manager','manager2','analyst'])await tx\`insert into team_members values(\${normal[0].id},\${ids[name]}) on conflict do nothing\`;for(const name of ['independent','independent2'])await tx\`insert into team_members values(\${restricted[0].id},\${ids[name]}) on conflict do nothing\`;const body={...defaultSettings,defaultTeamId:normal[0].id,restrictedTeamId:restricted[0].id,retention:{cases:365,contacts:365,evidence:365,transcripts:365,audit:365,backups:365}};await tx\`insert into settings(id,body,configured) values(1,\${tx.json(body)}::jsonb,true) on conflict(id) do update set body=excluded.body,configured=true,version=settings.version+1\`;});console.log('Development browser fixture accounts ready.');}finally{await db.end();}`;
const result = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    file,
    "run",
    "--rm",
    "--no-deps",
    "case-migrate",
    "node",
    "--input-type=module",
    "-e",
    code,
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
// Scope submission-budget cleanup to the current development frontend's addresses.
const web = spawnSync(
  "docker",
  ["compose", "--env-file", file, "ps", "-q", "web"],
  { encoding: "utf8" },
);
if (web.status !== 0)
  throw new Error("Cannot inspect the development frontend");
if (web.stdout.trim()) {
  const inspected = spawnSync(
    "docker",
    [
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      web.stdout.trim(),
    ],
    { encoding: "utf8" },
  );
  if (inspected.status !== 0)
    throw new Error("Cannot inspect development frontend addresses");
  const addresses = Object.values(JSON.parse(inspected.stdout))
    .flatMap((network) => [network.IPAddress, network.GlobalIPv6Address])
    .filter(Boolean);
  const resetCode = `import postgres from 'postgres'; import {mac} from '@whistle/runtime'; import {loadConfig} from './dist/config.js'; const config=loadConfig(); if(config.env!=='development')throw new Error('Submission fixture reset is limited to development'); const db=postgres(config.dbUrl,{max:1}); try{const staff=await db\`select email from staff\`;if(staff.some(s=>!s.email.startsWith('e2e-')))throw new Error('Non-test staff present; refusing budget reset');for(const ip of ${JSON.stringify(addresses)})await db\`delete from rate_limits where key=\${'limit:'+mac(config.abuseKey,'submit:'+ip)}\`;console.log('Development frontend submission budgets ready.');}finally{await db.end();}`;
  const reset = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      file,
      "run",
      "--rm",
      "--no-deps",
      "case-api",
      "node",
      "--input-type=module",
      "-e",
      resetCode,
    ],
    { stdio: "inherit" },
  );
  process.exitCode = reset.status ?? 1;
}
