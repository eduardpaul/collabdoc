import Underline from '@tiptap/extension-underline'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'

export const MarkdownUnderline = Underline.extend({
  renderMarkdown: (node, helpers) => `<u>${helpers.renderChildren(node)}</u>`
})

export const MarkdownSuperscript = Superscript.extend({
  inclusive: false,
  markdownTokenizer: {
    name: 'superscript',
    level: 'inline',
    start: (src) => src.indexOf('^'),
    tokenize: (src, _tokens, lexer) => {
      const match = /^\^([^\s^]+)\^/.exec(src)
      if (!match) {
        return undefined
      }
      return {
        type: 'superscript',
        raw: match[0],
        tokens: lexer.inlineTokens(match[1])
      }
    }
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('superscript', helpers.parseInline(token.tokens || [])),
  renderMarkdown: (node, helpers) => `^${helpers.renderChildren(node)}^`
})

export const MarkdownSubscript = Subscript.extend({
  inclusive: false,
  markdownTokenizer: {
    name: 'subscript',
    level: 'inline',
    start: (src) => {
      if (src.startsWith('~~')) {
        return -1
      }
      return src.startsWith('~') ? 0 : src.search(/(?<!~)~(?!~)/)
    },
    tokenize: (src, _tokens, lexer) => {
      if (src.startsWith('~~')) {
        return undefined
      }
      const match = /^~([^~\n]+)~/.exec(src)
      if (!match) {
        return undefined
      }
      return {
        type: 'subscript',
        raw: match[0],
        tokens: lexer.inlineTokens(match[1])
      }
    }
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('subscript', helpers.parseInline(token.tokens || [])),
  renderMarkdown: (node, helpers) => `~${helpers.renderChildren(node)}~`
})
