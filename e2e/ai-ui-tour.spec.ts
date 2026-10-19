import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { and, eq, inArray } from 'drizzle-orm';
import { SEED_REPO_NAMES, core, createDb, read } from '@repopulse/shared';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W19-12: a visual tour of the AI-layer screens - the AI review pass panel, the
// scheduled-passes section and the finding drawer's AI suggestions - in DARK,
// LIGHT and a PHONE width, with realistic stored data, and axe on each state.
//
// Opt-in, because it seeds rows and writes PNGs:
//
//   E2E_AI_TOUR=1 pnpm e2e e2e/ai-ui-tour.spec.ts
//
// PNGs go to docs/screenshots/w19/ (override with AI_TOUR_OUT). The data is made
// up for the pictures; every row it creates is removed afterwards.

const enabled = process.env.E2E_AI_TOUR === '1';
const OUT = process.env.AI_TOUR_OUT ?? join('docs', 'screenshots', 'w19');

test.describe('AI layer UI tour', () => {
  test.skip(!enabled, 'set E2E_AI_TOUR=1 to run the screenshot tour');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  // Tall, so a long panel is photographed whole rather than scrolled and clipped.
  test.use({ viewport: { width: 1100, height: 1900 } });

  const url = process.env.DATABASE_URL;
  const db = createDb(url ?? 'postgres://invalid');
  let WS = 0;
  let REPO = 0;
  let USER = 0;
  const findingIds: number[] = [];
  const providerIds: number[] = [];

  test.beforeAll(async () => {
    if (!url) throw new Error('DATABASE_URL is not set');
    mkdirSync(OUT, { recursive: true });
    const [repo] = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.name, SEED_REPO_NAMES[0] as string))
      .limit(1);
    REPO = repo!.id;
    WS = repo!.workspaceId;
    const [user] = await db.select({ id: core.users.id }).from(core.users).limit(1);
    USER = user!.id;
    const fs = await db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(eq(read.findings.workspaceId, WS))
      .orderBy(read.findings.id)
      .limit(3);
    findingIds.push(...fs.map((f) => f.id));
    expect(findingIds.length).toBeGreaterThanOrEqual(3);
    await wipe();
  });

  async function wipe() {
    await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, WS));
    await db.delete(read.aiFindingProvenance).where(eq(read.aiFindingProvenance.workspaceId, WS));
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS));
    await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, WS));
    await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, WS));
    await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, WS));
    await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, WS));
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WS));
  }
  test.afterAll(async () => {
    await wipe();
    await db.$client.end();
  });

  async function provider(name: string, baseUrl: string) {
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId: WS,
        name,
        kind: 'openai_compatible',
        baseUrl,
        model: 'qwen/qwen3.8-27b',
        allowPublicHost: !baseUrl.includes('10.0.0.'),
      })
      .returning({ id: core.llmProviders.id });
    providerIds.push(p!.id);
    return p!.id;
  }

  /** Dark first (the app's default), then light. */
  async function themes(page: Page, name: string, target: () => Locator, axe = true) {
    for (const theme of ['dark', 'light'] as const) {
      const current = await page.locator('html').getAttribute('data-theme');
      if (current !== theme) {
        await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      }
      await target().scrollIntoViewIfNeeded();
      await target().screenshot({
        path: join(OUT, `${name}-${theme}.png`),
        animations: 'disabled',
      });
      if (axe) await expectNoA11yViolations(page);
    }
  }
  const securityTab = async (page: Page) => {
    await loginAsFixture(page);
    await page.goto(`/repos/${REPO}/security`);
    await expect(page.getByTestId('ai-pass-panel')).toBeVisible();
    await expect(page.getByTestId('scheduled-passes')).toBeVisible();
  };
  const drawer = async (page: Page, id: number) => {
    await loginAsFixture(page);
    await page.goto(`/findings?finding=${id}`);
    await expect(page.getByTestId('finding-detail')).toBeVisible();
    await expect(page.getByTestId('ai-section')).toBeVisible();
  };

  test('panel and schedule: nothing run yet, schedule off', async ({ page }) => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    await securityTab(page);
    await expect(page.getByTestId('ai-pass-not-run')).toBeVisible();
    await expect(page.getByTestId('schedule-off')).toBeVisible();
    await themes(page, '01-panel-not-run', () => page.getByTestId('security-ai-pass'));
  });

  test('enable form: models stay on the network', async ({ page }) => {
    await securityTab(page);
    await page.getByTestId('schedule-edit').click();
    await page.getByTestId('schedule-paths').fill('src/payments\nsrc/auth');
    await expect(page.getByTestId('schedule-egress')).toHaveAttribute('data-leaves', 'false');
    await expect(page.getByTestId('schedule-enable')).toBeDisabled();
    await themes(page, '02-schedule-form-stays-home', () => page.getByTestId('scheduled-passes'));
  });

  test('enable form: a hosted model would receive source', async ({ page }) => {
    const hosted = await provider('Hosted model', 'https://api.example.com/v1');
    await db.insert(core.llmRoleRoutes).values({
      workspaceId: WS,
      role: 'security',
      position: 0,
      providerId: hosted,
    });
    await securityTab(page);
    await page.getByTestId('schedule-edit').click();
    await expect(page.getByTestId('schedule-egress')).toHaveAttribute('data-leaves', 'true');
    await page.getByTestId('schedule-ack').check();
    await expect(page.getByTestId('schedule-enable')).toBeDisabled(); // no paths yet
    await page.getByTestId('schedule-scope-prs').check();
    await expect(page.getByTestId('schedule-enable')).toBeEnabled();
    await themes(page, '03-schedule-form-leaves-network', () =>
      page.getByTestId('scheduled-passes'),
    );
    // And the real enable round trip: acknowledged, stored, shown as on.
    await page.getByTestId('schedule-enable').click();
    await expect(page.getByTestId('schedule-on')).toBeVisible();
    await expect(page.getByTestId('schedule-times')).toContainText('enabled');
    await themes(page, '04-schedule-on', () => page.getByTestId('scheduled-passes'));
  });

  test('schedule on, and the routing then changed: stopped, loudly', async ({ page }) => {
    // The acknowledgement was for the hosted link only; add another destination.
    await provider('Second hosted model', 'https://api.other.example/v1');
    await db.insert(core.llmRoleRoutes).values({
      workspaceId: WS,
      role: 'triage',
      position: 0,
      providerId: providerIds.at(-1)!,
    });
    await securityTab(page);
    await expect(page.getByTestId('schedule-stale')).toBeVisible();
    await themes(page, '05-schedule-stale-acknowledgement', () =>
      page.getByTestId('scheduled-passes'),
    );
  });

  test('history of passes: paths, a pull request, a commit range, a failure, and skipped scheduled runs', async ({
    page,
  }) => {
    await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, WS));
    await db.delete(core.llmProviders).where(inArray(core.llmProviders.id, providerIds));
    providerIds.length = 0;
    const base = Date.now();
    const at = (hoursAgo: number) => new Date(base - hoursAgo * 3_600_000);
    const runs = await db
      .insert(read.aiPassRuns)
      .values([
        {
          workspaceId: WS,
          repoId: REPO,
          requestedBy: USER,
          paths: ['src/payments'],
          status: 'succeeded',
          commitSha: 'a1b2c3d4e5f6',
          calls: 12,
          plan: {},
          specialists: {
            usage: { security: { calls: 4, findings: 2 }, code_health: { calls: 3, findings: 1 } },
            droppedForBudget: ['ai_slop'],
          },
          triageFunnel: {
            candidates: 6,
            selected: 5,
            triaged: 5,
            accepted: 5,
            verdicts: { real: 2, likely_false_positive: 2, needs_human: 1 },
          },
          createdAt: at(30),
          startedAt: at(30),
          finishedAt: at(29),
        },
        {
          workspaceId: WS,
          repoId: REPO,
          requestedBy: USER,
          paths: [],
          mode: 'pull_request',
          prNumber: 42,
          baseRef: 'main',
          headRef: 'f00dfeed1234abcd',
          status: 'succeeded',
          calls: 8,
          specialists: {
            usage: { security: { calls: 3, findings: 1 } },
            unreadable: ['assets/bundle.min.js'],
          },
          triageFunnel: {
            candidates: 1,
            selected: 1,
            triaged: 1,
            accepted: 1,
            verdicts: { likely_false_positive: 1 },
          },
          createdAt: at(20),
          finishedAt: at(19),
        },
        {
          workspaceId: WS,
          repoId: REPO,
          requestedBy: USER,
          paths: [],
          mode: 'commit_range',
          baseRef: '11112222aaaa',
          headRef: '33334444bbbb',
          status: 'failed',
          reasonCode: 'too_large',
          reason:
            'That range has more than 10 commits; a pass reviews at most 10. Pick a closer base.',
          createdAt: at(10),
          finishedAt: at(10),
        },
        {
          workspaceId: WS,
          repoId: REPO,
          requestedBy: USER,
          paths: ['src/payments'],
          trigger: 'scheduled',
          status: 'skipped',
          reasonCode: 'cap_reached',
          reason:
            "This workspace's monthly cap of 300 model calls is used up (298 so far this month), so the scheduled pass did not run. It resumes next month, or when an admin raises the cap.",
          createdAt: at(2),
          finishedAt: at(2),
        },
      ])
      .returning({ id: read.aiPassRuns.id });
    expect(runs).toHaveLength(4);
    await db
      .insert(read.aiPassSettings)
      .values({ workspaceId: WS, monthlyCallCap: 300, updatedBy: USER });
    await securityTab(page);
    await expect(page.getByTestId('ai-pass-runs')).toBeVisible();
    await themes(page, '06-panel-with-history', () => page.getByTestId('security-ai-pass'));
  });

  test('finding drawer: no AI review recorded yet', async ({ page }) => {
    await drawer(page, findingIds[0]!);
    await expect(page.getByTestId('ai-not-run')).toBeVisible();
    await themes(page, '07-drawer-not-run', () => page.getByTestId('finding-detail'));
  });

  test('finding drawer: open suggestion, accepted false-positive, AI-raised finding (reusing the first finding, after its not-run picture)', async ({
    page,
  }) => {
    const [pr] = await db
      .select({ id: read.aiPassRuns.id })
      .from(read.aiPassRuns)
      .where(and(eq(read.aiPassRuns.workspaceId, WS), eq(read.aiPassRuns.mode, 'pull_request')))
      .limit(1);
    const [paths] = await db
      .select({ id: read.aiPassRuns.id })
      .from(read.aiPassRuns)
      .where(
        and(
          eq(read.aiPassRuns.workspaceId, WS),
          eq(read.aiPassRuns.mode, 'paths'),
          eq(read.aiPassRuns.trigger, 'manual'),
        ),
      )
      .limit(1);
    // Citations that match the finding they are shown on (our copy of its lines).
    const rows = await db
      .select({
        id: read.findings.id,
        file: read.findings.file,
        line: read.findings.lineStart,
        evidence: read.findings.evidence,
      })
      .from(read.findings)
      .where(inArray(read.findings.id, findingIds));
    const cite = (id: number, extra = 0) => {
      const f = rows.find((r) => r.id === id)!;
      return {
        file: f.file ?? 'src/unknown.ts',
        line: (f.line ?? 1) + extra,
        text: (f.evidence ?? '').split('\n')[0]!.slice(0, 110),
      };
    };
    const route = { providerName: 'LM Studio', model: 'qwen/qwen3.8-27b', linkIndex: 0 };
    const common = {
      workspaceId: WS,
      model: 'qwen/qwen3.8-27b',
      checklistVersion: 'triage.v1',
      route,
    };
    await db.insert(read.aiTriageVerdicts).values([
      {
        ...common,
        findingId: findingIds[1]!,
        aiPassRunId: pr!.id,
        verdict: 'likely_false_positive',
        confidence: 4,
        rationale:
          'The flagged value is a constant or comes from a fixed allow-list, never from request input; the user-controlled value is handled separately two lines below.',
        citations: [cite(findingIds[1]!)],
        vexJustification: 'inline_mitigations_already_exist',
        vexStatement: 'The value comes from a fixed allow-list; user input is bound separately.',
        patchStatus: 'not_attempted',
      },
      {
        ...common,
        findingId: findingIds[2]!,
        aiPassRunId: paths!.id,
        verdict: 'likely_false_positive',
        confidence: 5,
        rationale: 'The input is validated against a strict schema before it reaches this line.',
        citations: [cite(findingIds[2]!)],
        patchStatus: 'not_attempted',
        decision: 'accepted',
        decidedBy: USER,
        decidedAt: new Date(),
      },
    ]);
    await db.insert(read.aiFindingProvenance).values({
      workspaceId: WS,
      findingId: findingIds[0]!,
      aiPassRunId: paths!.id,
      specialist: 'security',
      checklistVersion: 'security.v1',
      model: 'qwen/qwen3.8-27b',
      route,
    });

    await drawer(page, findingIds[1]!);
    await expect(page.getByTestId('ai-decide')).toBeVisible();
    await themes(page, '08-drawer-suggestion-open', () => page.getByTestId('finding-detail'));

    await drawer(page, findingIds[2]!);
    await expect(page.getByTestId('ai-offer-dismiss')).toBeVisible();
    await themes(page, '09-drawer-accepted-offers-dismiss', () =>
      page.getByTestId('finding-detail'),
    );

    await drawer(page, findingIds[0]!);
    await expect(page.getByTestId('ai-raised-by')).toBeVisible();
    await themes(page, '10-drawer-ai-raised', () => page.getByTestId('finding-detail'));
  });

  test('Models page: connections exist (form behind Advanced), routing sentences, quality table', async ({
    page,
  }) => {
    await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, WS));
    await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, WS));
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WS));
    const lm = await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    await provider('Backup (LAN)', 'http://10.0.0.6:1234/v1');
    await db
      .insert(core.llmRoleRoutes)
      .values({ workspaceId: WS, role: 'security', position: 0, providerId: lm });
    await loginAsFixture(page);
    await page.goto('/admin/models');
    await expect(page.getByTestId('llm-advanced')).toBeVisible();
    await expect(page.getByTestId('routing-effective-security')).toBeVisible();
    await expect(page.getByTestId('model-eval-table')).toBeVisible();
    await themes(page, '13-models-page-with-connections', () => page.getByTestId('llm-routing'));
    await themes(
      page,
      '14-models-advanced-collapsed',
      () => page.getByTestId('llm-advanced'),
      false,
    );
    await themes(page, '15-quality-table-split-columns', () => page.getByTestId('model-eval'));
  });

  test('model wizard: the buttons that are greyed out say what is missing', async ({ page }) => {
    await loginAsFixture(page);
    await page.goto('/admin/models');
    await page.getByTestId('wizard-where-hosted').check();
    await page.getByTestId('wizard-next-0').click();
    await expect(page.getByTestId('wizard-save-hint')).toBeVisible();
    await themes(page, '16-wizard-disabled-buttons-explain', () =>
      page.getByTestId('models-wizard'),
    );
  });

  test('Security tab: the AI review pass sits right under the scanner coverage', async ({
    page,
  }) => {
    await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, WS));
    await securityTab(page);
    await themes(
      page,
      '17-security-tab-ai-panel-up',
      () => page.getByTestId('security-tab'),
      false,
    );
  });

  test('phone width: the enable form and a suggestion', async ({ page }) => {
    await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, WS));
    await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, WS));
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WS));
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    await loginAsFixture(page);

    // The theme toggle lives in the rail, which a phone replaces with a drawer, so
    // the theme is set at desktop width (it is persisted) and the page then viewed
    // at 375px.
    const asTheme = async (theme: 'dark' | 'light') => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.goto('/');
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
        await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      }
      // 375 wide and tall, so a long section is photographed whole.
      await page.setViewportSize({ width: 375, height: 2600 });
    };
    const noSidewaysScroll = async (what: string) => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${what} scrolls sideways at 375px`).toBeLessThanOrEqual(0);
    };
    for (const theme of ['dark', 'light'] as const) {
      await asTheme(theme);
      await securityTab(page);
      await page.getByTestId('schedule-edit').click();
      await page.getByTestId('schedule-paths').fill('src/payments');
      await noSidewaysScroll('the schedule form');
      const form = page.getByTestId('scheduled-passes');
      await form.scrollIntoViewIfNeeded();
      await form.screenshot({
        path: join(OUT, `11-phone-schedule-form-${theme}.png`),
        animations: 'disabled',
      });
      await expectNoA11yViolations(page);

      await drawer(page, findingIds[1]!);
      await noSidewaysScroll('the drawer');
      await page.getByTestId('finding-detail').screenshot({
        path: join(OUT, `12-phone-drawer-suggestion-${theme}.png`),
        animations: 'disabled',
      });
      await expectNoA11yViolations(page);
    }
  });
});
