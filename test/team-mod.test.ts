import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TeamIdentityRow } from "../src/team-look-orders.ts";

const rows: TeamIdentityRow[] = [
  { series: "f1", team: "Kubica GrandPrix", team_id: 7, color_id: 129, primary_colour: "#c8102e", secondary_colour: "#ffffff",
    tertiary_colour: "#1a1a1a", trim_colour: "#f2c200", livery_id: 27, logo_path: "f1/k.png", logo_approved_at: "2026-10-05T00:00:00Z" },
  { series: "main", team: "Garuda Racing", team_id: 30, color_id: 131, primary_colour: "#123456", secondary_colour: "#ffffff",
    tertiary_colour: "#000000", trim_colour: "#ffffff", livery_id: 20, logo_path: null, logo_approved_at: null },
];

// A small red PNG, as a member upload.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAYAAAACCAYAAAB7Xa1eAAAAFUlEQVR4nGM8IaD3nwELYMImCBIDAGAiAgna7We1AAAAAElFTkSuQmCC", "base64");

vi.mock("../src/supabase.ts", () => ({
  rest: vi.fn(async (_env: unknown, _m: string, path: string) => {
    if (path === "rpc/all_team_identities") return rows;
    throw new Error(`unexpected ${path}`);
  }),
  storageDownload: vi.fn(async () => PNG),
  storageUpload: vi.fn(),
}));

const { buildTeamMod } = await import("../src/team-look-orders.ts");
const env = { url: "https://x", serviceKey: "k" };
const GAME_LOGOS = join(process.env.HOME ?? "", "Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/MM_Data/Modding/Images/teamlogos");
const py = process.env.MM_PYTHON;
const hasUnityPy = !!py && spawnSync(py, ["-c", "import UnityPy"]).status === 0;

describe("team mod", () => {
  it("writes every series' colour rows, gaps filled, and asks for the logo base", async () => {
    const out = mkdtempSync(join(tmpdir(), "team-mod-"));
    await expect(buildTeamMod(env, { out }, () => {})).rejects.toThrow(/--logos-base/);
    const text = readFileSync(join(out, "Modding", "Databases", "Team Colours.txt"), "utf8");
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(1 + 132);
    expect(lines[130].startsWith("129,#c8102e,")).toBe(true);
    expect(lines[132].startsWith("131,#123456,")).toBe(true);
  });

  it.skipIf(!hasUnityPy || !existsSync(GAME_LOGOS))("adds approved logos to a copy of the logo bundle", async () => {
    const out = mkdtempSync(join(tmpdir(), "team-mod-"));
    const log: string[] = [];
    const r = await buildTeamMod(env, { out, logosBase: GAME_LOGOS, python: py }, (l) => log.push(l));
    expect(r).toEqual({ colours: 2, logos: 1 });
    expect(existsSync(join(out, "Modding", "Images", "teamlogos"))).toBe(true);
    const check = spawnSync(py!, ["-c", `import UnityPy,sys
env=UnityPy.load(sys.argv[1])
print(sorted(o.peek_name() for o in env.objects if o.type.name=="Texture2D" and o.peek_name().endswith("_7")))`, join(out, "Modding", "Images", "teamlogos")], { encoding: "utf8" });
    expect(check.stdout).toContain("'Team_7'");
    expect(check.stdout).toContain("'TeamBW_7'");
  }, 120_000);
});
