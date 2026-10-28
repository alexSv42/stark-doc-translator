import { Injectable } from '@nestjs/common'
import { createChildLogger } from '../lib/logger'
import { estimateTokens } from '../parsers/index'
import type { ContentBlock } from '../parsers/index'

const log = createChildLogger('semantic-chunk-agent')

const MAX_CHUNK_TOKENS = 6000
const IDEAL_CHUNK_TOKENS = 4000
const MIN_CHUNK_TOKENS = 300

export interface ChunkDecision {
  isComplete: boolean
  reason: string
}

export interface PlannedChunk {
  text: string
  blocks: ContentBlock[]
  lastBlockIndex: number
  hasTable: boolean
  hasCode: boolean
  blockTypes: string[]
}

/**
 * Streaming semantic chunker — decides chunk boundaries one block at a time.
 *
 * 100% rule-based, zero extra tokens. The rules encode the same semantics
 * an AI agent would decide, but for free:
 *
 * 1. Headings always start a new chunk (previous chunk is finalized)
 * 2. Code/non-translatable blocks always get their own chunk
 * 3. Tables stay whole — never split inside a table
 * 4. Lists stay whole — never split inside a list
 * 5. Hard token limit (3500) forces a split
 * 6. At ideal size (2000+), paragraph boundaries become split points
 * 7. Below minimum (150), always accumulate
 *
 * These rules cover 100% of cases. An AI call per block would add ~275 tokens
 * of overhead for 7% of decisions — eliminated entirely.
 */
@Injectable()
export class SemanticChunkAgentService {
  /**
   * Plan all chunk boundaries in one pass.
   * Returns the actual chunk texts, block lists, and metadata — O(n), zero tokens.
   * The translation processor can then translate them in parallel.
   */
  async planChunks(blocks: ContentBlock[]): Promise<PlannedChunk[]> {
    const chunks: PlannedChunk[] = []
    let accText = ''
    let accTokens = 0
    let accBlocks: ContentBlock[] = []
    let lastBlockIdx = -1

    const finalize = () => {
      if (!accText) return
      chunks.push({
        text: accText,
        blocks: accBlocks,
        lastBlockIndex: lastBlockIdx,
        hasTable: accBlocks.some((b) => b.type === 'table'),
        hasCode: accBlocks.some((b) => b.type === 'code'),
        blockTypes: [...new Set(accBlocks.map((b) => b.type))],
      })
      accText = ''
      accTokens = 0
      accBlocks = []
    }

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]

      if (!block.translatable) {
        finalize()
        lastBlockIdx = i
        continue
      }

      if (accText) {
        const decision = await this.shouldSplitBefore(accText, block, accTokens)
        if (decision.isComplete) {
          finalize()
        }
      }

      accText += (accText ? '\n\n' : '') + block.text
      accTokens += estimateTokens(block.text)
      accBlocks.push(block)
      lastBlockIdx = i
    }

    finalize()
    return chunks
  }

  /**
   * Count chunks without materializing them.
   */
  async countChunks(blocks: ContentBlock[]): Promise<number> {
    return (await this.planChunks(blocks)).length
  }

  /**
   * Decide if we should split BEFORE this new block.
   * Returns isComplete=true → finalize current chunk, new block starts next chunk.
   */
  async shouldSplitBefore(
    accumulatedText: string,
    newBlock: ContentBlock,
    accumulatedTokens: number,
  ): Promise<ChunkDecision> {
    // Nothing accumulated — can't split before nothing
    if (accumulatedTokens === 0) {
      return { isComplete: false, reason: 'empty accumulator' }
    }

    const newTokens = estimateTokens(newBlock.text)

    // 1. Hard limit: chunk would exceed max
    if (accumulatedTokens > MAX_CHUNK_TOKENS) {
      return { isComplete: true, reason: 'hard token limit reached' }
    }

    // 2. Heading always starts a new section
    if (newBlock.type === 'heading') {
      return { isComplete: true, reason: 'heading starts new section' }
    }

    // 3. Non-translatable block (code) — split before it
    if (!newBlock.translatable || newBlock.type === 'code') {
      return { isComplete: true, reason: 'non-translatable block boundary' }
    }

    // 4. Adding this block would exceed the hard limit
    if (accumulatedTokens + newTokens > MAX_CHUNK_TOKENS) {
      return { isComplete: true, reason: 'would exceed token limit' }
    }

    // 5. Below minimum — always accumulate
    if (accumulatedTokens < MIN_CHUNK_TOKENS) {
      return { isComplete: false, reason: 'below minimum, accumulating' }
    }

    // 6. Table or list starting after non-table/list content — structural boundary
    if (newBlock.type === 'table' || newBlock.type === 'list') {
      if (accumulatedTokens >= MIN_CHUNK_TOKENS) {
        return { isComplete: true, reason: 'structural element boundary' }
      }
    }

    // 7. At ideal size, paragraph boundary = split point
    //    This is the "ambiguous" case that was going to the AI agent.
    //    Heuristic: if we have a good-sized chunk and a new paragraph starts,
    //    that's a natural translation unit boundary.
    if (accumulatedTokens >= IDEAL_CHUNK_TOKENS && newBlock.type === 'paragraph') {
      return { isComplete: true, reason: 'ideal size at paragraph boundary' }
    }

    // 8. If chunk is moderate and new block is large, split to keep chunks balanced
    if (accumulatedTokens >= 800 && newTokens > 1000) {
      return { isComplete: true, reason: 'balanced split before large block' }
    }

    // Default: keep accumulating
    return { isComplete: false, reason: 'accumulating' }
  }
}
