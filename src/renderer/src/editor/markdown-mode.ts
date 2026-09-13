let singleFileExport = false

export function setMarkdownSingleFile(value: boolean): void {
  singleFileExport = value
}

export function isMarkdownSingleFile(): boolean {
  return singleFileExport
}
