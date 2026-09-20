import {
  AlignmentType,
  BorderStyle,
  LevelFormat,
  ShadingType,
  type IBaseParagraphStyleOptions,
  type ILevelsOptions,
  type INumberingOptions,
  type IParagraphStyleOptions,
  type ICharacterStyleOptions,
  type IStylesOptions
} from 'docx'
import type { DocxExportConfig } from '../../shared/docx-config'
import { mmToDxa } from './geometry'

function pt(size: number): number {
  return Math.round(size * 2)
}

export function documentStyles(config: DocxExportConfig): IStylesOptions {
  const body = config.typography.body
  const heading = config.typography.heading
  const mono = config.typography.mono
  const base = config.typography.baseSizePt
  const headingSizes = [base + 5, base + 3, base + 1, base]
  // Title and Heading1..4 already exist in docx's default style set; overriding them
  // there keeps one definition per styleId (a duplicate makes Word pick its own blue one).
  const headingStyle = (index: number): IBaseParagraphStyleOptions => ({
    run: { font: heading, size: pt(headingSizes[index]), bold: true },
    paragraph: {
      spacing: { before: 240 - index * 40, after: 120 },
      outlineLevel: index,
      keepNext: true
    }
  })

  const paragraphStyles: IParagraphStyleOptions[] = [
    {
      id: 'Subtitle',
      name: 'Subtitle',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: body, size: pt(base), color: '666666' },
      paragraph: { spacing: { before: 0, after: 200 } }
    },
    {
      id: 'Quote',
      name: 'Quote',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: body, italics: true, color: '555555' },
      paragraph: {
        indent: { left: mmToDxa(5) },
        border: {
          left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 8 }
        },
        spacing: { before: 80, after: 80 }
      }
    },
    {
      id: 'Code',
      name: 'Code',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: mono, size: pt(base - 1.5) },
      paragraph: {
        shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
        keepLines: true,
        spacing: { before: 80, after: 80 }
      }
    },
    {
      id: 'Caption',
      name: 'Caption',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { font: body, size: pt(base - 1), italics: true, color: '444444' },
      paragraph: { spacing: { before: 60, after: 200 } }
    }
  ]

  const characterStyles: ICharacterStyleOptions[] = [
    {
      id: 'CodeChar',
      name: 'Code Char',
      basedOn: 'DefaultParagraphFont',
      run: {
        font: mono,
        size: pt(base - 1.5),
        shading: { type: ShadingType.CLEAR, fill: 'F0F0F0' }
      }
    }
  ]

  return {
    default: {
      document: {
        run: {
          font: body,
          size: pt(base),
          language: { value: config.lang }
        }
      },
      title: {
        run: { font: heading, size: pt(base + 15), bold: true },
        paragraph: { spacing: { before: 0, after: 200 } }
      },
      heading1: headingStyle(0),
      heading2: headingStyle(1),
      heading3: headingStyle(2),
      heading4: headingStyle(3)
    },
    paragraphStyles,
    characterStyles
  }
}

export function numberingConfig(): INumberingOptions {
  const indentLevel = (level: number): ILevelsOptions['style'] => ({
    paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } }
  })
  const bulletLevels: ILevelsOptions[] = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: '•',
    alignment: AlignmentType.LEFT,
    style: indentLevel(level)
  }))
  const decimalLevels: ILevelsOptions[] = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: indentLevel(level)
  }))
  return {
    config: [
      { reference: 'bullets', levels: bulletLevels },
      { reference: 'numbers', levels: decimalLevels }
    ]
  }
}
