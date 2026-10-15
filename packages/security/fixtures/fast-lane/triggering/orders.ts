// Fixture for slop.exception_control_flow (W18-09). `expect:` names the rule
// that must report the NEXT line.
import type { Request, Response } from 'express';

export async function createOrder(req: Request, res: Response): Promise<void> {
  try {
    if (!req.body.items?.length) {
      // expect: slop.exception_control_flow
      throw new Error('order has no items');
    }
    if (req.body.total < 0) throw new Error('negative total');
    await saveOrder(req.body);
    res.status(201).end();
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export function parseQuantity(raw: string): number {
  try {
    const n = Number(raw);
    // expect: slop.exception_control_flow
    if (!Number.isInteger(n)) throw new RangeError('not an integer');
    return n;
  } catch {
    return 0;
  }
}

export class Importer {
  async run(rows: string[]): Promise<number> {
    let failed = 0;
    for (const row of rows) {
      try {
        try {
          await this.importRow(row);
        } catch (inner) {
          // A throw from an inner handler still lands in the outer catch.
          // expect: slop.exception_control_flow
          throw new Error(`row failed: ${String(inner)}`);
        }
      } catch {
        failed += 1;
      }
    }
    return failed;
  }

  private async importRow(row: string): Promise<void> {
    await saveOrder({ row });
  }
}

declare function saveOrder(order: unknown): Promise<void>;
