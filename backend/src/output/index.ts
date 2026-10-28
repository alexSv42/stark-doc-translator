export interface TranslatedChunk {
  chunkIndex: number
  sourceText: string
  translatedText: string
  metadata: { hasTable?: boolean; hasCode?: boolean; blockTypes?: string[] } | null
}

export interface OutputResult {
  outputPath: string
  assembleDurationMs: number
}

export interface OutputGenerator {
  readonly format: string
  generate(
    chunks: TranslatedChunk[],
    outputPath: string,
    metadata: { title: string; sourceLanguage: string; targetLanguage: string },
  ): Promise<OutputResult>
}

let _generators: Map<string, OutputGenerator> | null = null

async function loadGenerators(): Promise<Map<string, OutputGenerator>> {
  if (!_generators) {
    const [{ PdfOutputGenerator }, { DocxOutputGenerator }, { MarkdownOutputGenerator }] = await Promise.all([
      import('./pdf-output'),
      import('./docx-output'),
      import('./markdown-output'),
    ])
    _generators = new Map<string, OutputGenerator>()
    for (const gen of [new PdfOutputGenerator(), new DocxOutputGenerator(), new MarkdownOutputGenerator()]) {
      _generators.set(gen.format, gen)
    }
  }
  return _generators
}

export async function getOutputGenerator(format: string): Promise<OutputGenerator> {
  const generators = await loadGenerators()
  const gen = generators.get(format)
  if (!gen) {
    throw new Error(`No output generator for format '${format}'`)
  }
  return gen
}
