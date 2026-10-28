import { describe, it, expect, beforeEach } from 'vitest'
import { SemanticChunkAgentService } from '../../src/agents/semantic-chunk-agent'
import type { ContentBlock } from '../../src/parsers/index'

function block(type: ContentBlock['type'], text: string, translatable = true): ContentBlock {
  return { type, text, pageNumber: 1, translatable }
}

describe('SemanticChunkAgent — 100% rule-based, zero tokens', () => {
  let agent: SemanticChunkAgentService

  beforeEach(() => {
    agent = new SemanticChunkAgentService()
  })

  it('splits before a heading', async () => {
    const result = await agent.shouldSplitBefore(
      'Some existing paragraph text.',
      block('heading', '## New Section'),
      200,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('heading')
  })

  it('splits before a code block (non-translatable)', async () => {
    const result = await agent.shouldSplitBefore(
      'Some paragraph text here.',
      block('code', '```js\nconsole.log("hello")\n```', false),
      300,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('non-translatable')
  })

  it('splits when adding block would exceed token limit', async () => {
    const longText = 'word '.repeat(1000)
    const result = await agent.shouldSplitBefore(
      'Existing chunk text.',
      block('paragraph', longText),
      3000,
    )
    expect(result.isComplete).toBe(true)
  })

  it('does not split when chunk is below minimum', async () => {
    const result = await agent.shouldSplitBefore(
      'Short.',
      block('paragraph', 'Another short paragraph.'),
      10,
    )
    expect(result.isComplete).toBe(false)
    expect(result.reason).toContain('minimum')
  })

  it('does not split on empty accumulation', async () => {
    const result = await agent.shouldSplitBefore(
      '',
      block('paragraph', 'First paragraph.'),
      0,
    )
    expect(result.isComplete).toBe(false)
    expect(result.reason).toContain('empty')
  })

  it('splits at hard token limit', async () => {
    const result = await agent.shouldSplitBefore(
      'Existing accumulated text.',
      block('paragraph', 'More text.'),
      7000,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('hard token limit')
  })

  it('splits at ideal size on paragraph boundary', async () => {
    const result = await agent.shouldSplitBefore(
      'A chunk that has accumulated enough content to be a good translation unit.',
      block('paragraph', 'A new paragraph starting here.'),
      4200,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('ideal size')
  })

  it('keeps accumulating when below ideal size', async () => {
    const result = await agent.shouldSplitBefore(
      'Some accumulated text.',
      block('paragraph', 'More text to add.'),
      500,
    )
    expect(result.isComplete).toBe(false)
    expect(result.reason).toContain('accumulating')
  })

  it('splits before a table when text is accumulated', async () => {
    const result = await agent.shouldSplitBefore(
      'Some introductory text for context.',
      block('table', '| A | B |\n|---|---|\n| 1 | 2 |'),
      400,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('structural')
  })

  it('splits before a list when text is accumulated', async () => {
    const result = await agent.shouldSplitBefore(
      'Some introductory text.',
      block('list', '- item 1\n- item 2\n- item 3'),
      400,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('structural')
  })

  it('splits balanced before a large block', async () => {
    const largeBlock = 'word '.repeat(1200) // ~1200 tokens, exceeds 1000 threshold
    const result = await agent.shouldSplitBefore(
      'A moderate sized chunk.',
      block('paragraph', largeBlock),
      1000,
    )
    expect(result.isComplete).toBe(true)
    expect(result.reason).toContain('balanced')
  })
})
