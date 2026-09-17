// synthesize_concepts change detection + never-downgrade + configurable budget.
//
// Pins:
//   - an unchanged group is not rewritten (no LLM call, no page write)
//   - a membership change rewrites the concept
//   - a budget-exhausted run keeps an existing LLM narrative instead of
//     replacing it with a template stub, and still banks new member edges
//   - an empty-response fallback never replaces an existing LLM narrative
//   - an unchanged template page is upgraded to an LLM narrative when budget allows
//   - cycle.synthesize_concepts.budget_usd is honored (0 = template only)
//   - the member fingerprint is order-independent and tier-sensitive

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  runPhaseSynthesizeConcepts,
  resolveConceptsBudgetUsd,
  conceptMemberFingerprint,
  CONCEPTS_BUDGET_CONFIG_KEY,
} from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

type ChatFn = typeof import('../../src/core/ai/gateway.ts').chat;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '');
});

const CONCEPT = 'deliberate-practice';
const CONCEPT_SLUG = `concepts/${CONCEPT}`;

function atoms(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    slug: `atoms/2026-01-01/practice-${i}`,
    title: `Practice ${i}`,
    body: `Body of practice atom ${i}.`,
    concept_refs: [CONCEPT],
  }));
}

async function persist(list: ReturnType<typeof atoms>): Promise<void> {
  for (const a of list) {
    await engine.putPage(a.slug, { type: 'atom', title: a.title, compiled_truth: a.body, timeline: '' });
  }
}

function countingChat(calls: string[], text: string): ChatFn {
  return (async (o: ChatOpts): Promise<ChatResult> => {
    calls.push(String(o.messages[0]?.content));
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    };
  }) as ChatFn;
}

describe('synthesize_concepts change detection', () => {
  test('an unchanged group is not rewritten: no LLM call, no page write', async () => {
    const list = atoms(10);
    await persist(list);
    const first: string[] = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: list, _chat: countingChat(first, 'First narrative.') });
    expect(first).toHaveLength(1);
    const before = await engine.getPage(CONCEPT_SLUG);
    expect(before?.frontmatter.member_fingerprint).toBeTruthy();

    const second: string[] = [];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: list, _chat: countingChat(second, 'Second narrative.') });
    expect(second).toHaveLength(0);
    expect(result.details?.concepts_written).toBe(0);
    expect(result.details?.concepts_unchanged).toBe(1);
    const after = await engine.getPage(CONCEPT_SLUG);
    expect(after?.compiled_truth).toContain('First narrative.');
    expect(after?.frontmatter.synthesized_at).toBe(before?.frontmatter.synthesized_at);
  });

  test('a membership change rewrites the concept', async () => {
    await persist(atoms(11));
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(10), _chat: countingChat([], 'First narrative.') });
    const fp1 = (await engine.getPage(CONCEPT_SLUG))?.frontmatter.member_fingerprint;

    const calls: string[] = [];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(11), _chat: countingChat(calls, 'Grown narrative.') });
    expect(calls).toHaveLength(1);
    expect(result.details?.concepts_written).toBe(1);
    const page = await engine.getPage(CONCEPT_SLUG);
    expect(page?.compiled_truth).toContain('Grown narrative.');
    expect(page?.frontmatter.member_fingerprint).not.toBe(fp1);
  });

  test('budget exhausted: an existing LLM narrative is kept, and new member edges are still banked', async () => {
    await persist(atoms(11));
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(10), _chat: countingChat([], 'Original narrative.') });

    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '0');
    const calls: string[] = [];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(11), _chat: countingChat(calls, 'unused') });
    expect(calls).toHaveLength(0);
    expect(result.details?.concepts_kept_existing).toBe(1);
    expect(result.details?.concepts_written).toBe(0);
    const page = await engine.getPage(CONCEPT_SLUG);
    expect(page?.frontmatter.synthesis_mode).toBe('llm');
    expect(page?.compiled_truth).toContain('Original narrative.');

    const edges = (await engine.getLinks(CONCEPT_SLUG, { sourceId: 'default' }))
      .filter((l) => l.link_source === 'concept-provenance')
      .map((l) => l.to_slug);
    expect(edges).toContain('atoms/2026-01-01/practice-10');
  });

  test('an empty-response fallback never replaces an existing LLM narrative', async () => {
    await persist(atoms(11));
    await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(10), _chat: countingChat([], 'Original narrative.') });

    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms(11), _chat: countingChat([], '') });
    expect(result.status).toBe('warn');
    expect(result.details?.concepts_kept_existing).toBe(1);
    const page = await engine.getPage(CONCEPT_SLUG);
    expect(page?.frontmatter.synthesis_mode).toBe('llm');
    expect(page?.compiled_truth).toContain('Original narrative.');
  });

  test('an unchanged template page is upgraded to an LLM narrative once budget allows', async () => {
    const list = atoms(5); // T2
    await persist(list);
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '0');
    const none: string[] = [];
    await runPhaseSynthesizeConcepts(engine, { _atoms: list, _chat: countingChat(none, 'unused') });
    expect(none).toHaveLength(0);
    expect((await engine.getPage(CONCEPT_SLUG))?.frontmatter.synthesis_mode).toBe('budget_fallback');

    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '');
    const calls: string[] = [];
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: list, _chat: countingChat(calls, 'Upgraded narrative.') });
    expect(calls).toHaveLength(1);
    expect(result.details?.concepts_written).toBe(1);
    const page = await engine.getPage(CONCEPT_SLUG);
    expect(page?.frontmatter.synthesis_mode).toBe('llm');
    expect(page?.compiled_truth).toContain('Upgraded narrative.');
  });

  test('an unchanged T3 page (deterministic by design) is never rewritten', async () => {
    const list = atoms(3);
    await persist(list);
    await runPhaseSynthesizeConcepts(engine, { _atoms: list });
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: list });
    expect(result.details?.concepts_written).toBe(0);
    expect(result.details?.concepts_unchanged).toBe(1);
  });
});

describe('synthesize_concepts budget config', () => {
  test('unset falls back to the default ceiling', async () => {
    expect(await resolveConceptsBudgetUsd(engine)).toBe(1.5);
  });

  test('a configured value wins, including 0', async () => {
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '12.5');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(12.5);
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '0');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(0);
  });

  test('an invalid or negative value falls back to the default', async () => {
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, 'lots');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(1.5);
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '-1');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(1.5);
  });

  test('the configured ceiling is reported in the phase result', async () => {
    const list = atoms(3);
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '7');
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: list, dryRun: true });
    expect(result.details?.budget_usd).toBe(7);
  });
});

describe('conceptMemberFingerprint', () => {
  test('is independent of member order', () => {
    const a = conceptMemberFingerprint({ tier: 'T1', atomSlugs: ['atoms/b', 'atoms/a', 'atoms/c'] });
    const b = conceptMemberFingerprint({ tier: 'T1', atomSlugs: ['atoms/c', 'atoms/b', 'atoms/a'] });
    expect(a).toBe(b);
  });

  test('changes with membership and with tier', () => {
    const base = conceptMemberFingerprint({ tier: 'T2', atomSlugs: ['atoms/a', 'atoms/b'] });
    expect(conceptMemberFingerprint({ tier: 'T2', atomSlugs: ['atoms/a', 'atoms/c'] })).not.toBe(base);
    expect(conceptMemberFingerprint({ tier: 'T1', atomSlugs: ['atoms/a', 'atoms/b'] })).not.toBe(base);
  });
});
