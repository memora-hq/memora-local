const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

export function parsePatchFilePaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const match of patchText.matchAll(PATCH_FILE_LINE)) {
    paths.push(match[1].trim());
  }
  return paths;
}
