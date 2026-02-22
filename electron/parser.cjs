const mammoth = require('mammoth')
const crypto = require('crypto')

/**
 * Parse a Verbatim .docx tub file into a flat block array.
 * Heading hierarchy: H1 = Pocket, H2 = Hat, H3 = Block name, body = content
 */
async function parseTub(filePath) {
  const result = await mammoth.extractRawText({ path: filePath })
  // We need style info, so use convertToHtml and parse that instead
  const html = await mammoth.convertToHtml(
    { path: filePath },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1",
        "p[style-name='Heading 2'] => h2",
        "p[style-name='Heading 3'] => h3",
        "p[style-name='Heading 4'] => h4",
      ],
    }
  )

  return parseHtml(html.value, filePath)
}

function parseHtml(html, sourceFile) {
  const blocks = []
  let pocket = ''
  let hat = ''
  let blockName = ''
  let contentLines = []

  // Simple line-by-line tag parser
  const tagRegex = /<(h1|h2|h3|h4|p)[^>]*>(.*?)<\/\1>/gi
  let match

  const flush = () => {
    if (blockName && contentLines.length) {
      const content = contentLines.join('\n').trim()
      if (content) {
        blocks.push({
          id: crypto
            .createHash('md5')
            .update(`${pocket}|${hat}|${blockName}|${content.slice(0, 80)}`)
            .digest('hex')
            .slice(0, 12),
          pocket,
          hat,
          block: blockName,
          content,
          source: sourceFile,
        })
      }
    }
    contentLines = []
  }

  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1].toLowerCase()
    const text = match[2].replace(/<[^>]+>/g, '').trim()
    if (!text) continue

    if (tag === 'h1') {
      flush()
      pocket = text
      hat = ''
      blockName = ''
    } else if (tag === 'h2') {
      flush()
      hat = text
      blockName = ''
    } else if (tag === 'h3' || tag === 'h4') {
      flush()
      blockName = text
    } else if (tag === 'p' && blockName) {
      contentLines.push(text)
    }
  }

  flush()
  return blocks
}

module.exports = { parseTub }
