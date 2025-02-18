import { Diff, Hunk } from './types';
import { findBestMatch, prepareSearchString } from './searchStrategies';
import { applyEdit } from './editStrategies';

// Enhanced unified diff parser with indentation preservation
function parseUnifiedDiff(diff: string): Diff {
  const MAX_CONTEXT_LINES = 6; // Number of context lines to keep before/after changes
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
      if (currentHunk && currentHunk.changes.length > 0 && 
          currentHunk.changes.some(change => change.type === 'add' || change.type === 'remove')) {
        // Trim excess context, keeping only MAX_CONTEXT_LINES before/after changes
        const changes = currentHunk.changes;
        let startIdx = 0;
        let endIdx = changes.length - 1;
        
        // Find first non-context line
        for (let j = 0; j < changes.length; j++) {
          if (changes[j].type !== 'context') {
            startIdx = Math.max(0, j - MAX_CONTEXT_LINES);
            break;
          }
        }
        
        // Find last non-context line
        for (let j = changes.length - 1; j >= 0; j--) {
          if (changes[j].type !== 'context') {
            endIdx = Math.min(changes.length - 1, j + MAX_CONTEXT_LINES);
            break;
          }
        }
        
        currentHunk.changes = changes.slice(startIdx, endIdx + 1);
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

  if (currentHunk && currentHunk.changes.length > 0 && 
      currentHunk.changes.some(change => change.type === 'add' || change.type === 'remove')) {
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