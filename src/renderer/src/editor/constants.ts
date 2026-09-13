/**
 * The editor's vocabulary is the document core's vocabulary. Everything here
 * comes from `src/shared/constants` so the schema the renderer builds and the
 * tree the agents write cannot drift apart.
 */
export {
  ALLOWED_MARKS,
  ALLOWED_NODES,
  BLOCK_ID_ATTR,
  BLOCK_ID_TYPES,
  FIGURE_ALIGNS,
  FIGURE_TYPES,
  FIGURE_WIDTHS,
  HEADING_LEVELS,
  MAX_DOCUMENT_ASSET_BYTES,
  MAX_IMAGE_BYTES,
  SYNTAX_FIGURE_TYPES,
  TEXT_STYLE_CONFIG
} from '@shared/constants'
export type {
  AllowedMark,
  AllowedNode,
  FigureAlign,
  FigureWidth,
  HeadingLevel,
  TextStyleExpand
} from '@shared/constants'
