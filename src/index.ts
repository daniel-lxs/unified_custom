import { Diff, Hunk } from './types';
import { findBestMatch, prepareSearchString } from './searchStrategies';
import { applyEdit } from './editStrategies';

// Enhanced unified diff parser with indentation preservation
function parseUnifiedDiff(diff: string): Diff {
  const lines = diff.split('\n');
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) {
    i++;
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('@@')) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = { changes: [] };
      continue;
    }

    if (!currentHunk) continue;

    // Extract the complete indentation for each line
    const content = line.slice(1); // Remove the diff marker
    const indentMatch = content.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[0] : '';
    const trimmedContent = content.slice(indent.length);

    if (line.startsWith(' ')) {
      currentHunk.changes.push({
        type: 'context',
        content: trimmedContent,
        indent,
        originalLine: content
      });
    } else if (line.startsWith('+')) {
      currentHunk.changes.push({
        type: 'add',
        content: trimmedContent,
        indent,
        originalLine: content
      });
    } else if (line.startsWith('-')) {
      currentHunk.changes.push({
        type: 'remove',
        content: trimmedContent,
        indent,
        originalLine: content
      });
    }
  }

  if (currentHunk && currentHunk.changes.length > 0) {
    hunks.push(currentHunk);
  }

  return { hunks };
}

// Main function that uses pre/post processing
export async function main(originalContent: string, diff: string, debug: string = ''): Promise<string> {
  const MIN_CONFIDENCE = 0.9;
  const parsedDiff = parseUnifiedDiff(diff);
  const originalLines = originalContent.split('\n');
  let result = [...originalLines];
  
  for (const hunk of parsedDiff.hunks) {
    const contextStr = prepareSearchString(hunk.changes);
    const { index: matchPosition, confidence } = findBestMatch(contextStr, result);
    
    const editResult = await applyEdit(hunk, result, matchPosition, confidence, debug);
    if (editResult.confidence > MIN_CONFIDENCE) {
      result = editResult.result;
    } else {
      return originalContent // Return original content if any edit fails
    }
  }

  return result.join('\n');
}