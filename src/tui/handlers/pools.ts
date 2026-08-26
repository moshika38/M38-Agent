import Table from "cli-table3";
import { COLORS, renderPoolBadge } from "../branding.js";
import type { ModelRegistry } from "../../models/registry.js";

export function showPools(registry: ModelRegistry): void {
  console.log(
    "\n" +
      COLORS.primary("═══════════════════════════════════════════════════════════════")
  );
  console.log(
    "  " + COLORS.white("MODEL POOLS & REGISTRY") + "  " + COLORS.muted("│ Active model topology")
  );
  console.log(
    COLORS.primary("═══════════════════════════════════════════════════════════════")
  );

  for (const poolName of registry.getPools()) {
    const pool = registry.getPool(poolName);
    if (!pool) continue;

    console.log(`\n  ${renderPoolBadge(poolName)}  ${COLORS.muted(`— ${pool.label}`)}`);

    const table = new Table({
      head: [
        COLORS.white("Model ID"),
        COLORS.white("Priority"),
        COLORS.white("Context Window"),
        COLORS.white("Tier Bar"),
      ],
      style: { head: [], border: ["#4B5563"] },
      chars: {
        top: "", "top-mid": "", "top-left": "", "top-right": "",
        bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
        left: "  " + COLORS.muted("│"), "left-mid": "",
        mid: "", "mid-mid": "",
        right: COLORS.muted("│"), "right-mid": "",
        middle: COLORS.muted("│"),
      },
    });

    for (const m of pool.models) {
      const barFilled = "█".repeat(m.priority);
      const barEmpty = "░".repeat(10 - m.priority);
      table.push([
        COLORS.dim("• ") + m.id,
        m.priority === 10
          ? COLORS.primary(`★ ${m.priority}`)
          : m.priority >= 9
            ? COLORS.green(`${m.priority}`)
            : COLORS.yellow(`${m.priority}`),
        `${m.contextWindow.toLocaleString()} tokens`,
        COLORS.primary(barFilled) + COLORS.muted(barEmpty),
      ]);
    }

    console.log(table.toString());
  }

  console.log();
}
