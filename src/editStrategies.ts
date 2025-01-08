import { diff_match_patch } from 'diff-match-patch';
import * as git from 'isomorphic-git';
import { fs as memfs, vol } from 'memfs';
import { Change, EditResult, Hunk } from './types';
import { getDMPSimilarity, validateEditResult } from './searchStrategies';

// Helper function to infer indentation
function inferIndentation(line: string, contextLines: string[], previousIndent: string = ''): string {
  const match = line.match(/^(\s+)/);
  if (match) {
    return match[1];
  }

  for (const contextLine of contextLines) {
    const contextMatch = contextLine.match(/^(\s+)/);
    if (contextMatch) {
      const currentLineDepth = (line.match(/^\s*/)?.[0] || '').length;
      const contextLineDepth = contextMatch[1].length;
      
      if (currentLineDepth > contextLineDepth) {
        return contextMatch[1] + ' '.repeat(2);
      }
      return contextMatch[1];
    }
  }

  return previousIndent;
}

// Context matching edit strategy
export function applyContextMatching(hunk: Hunk, content: string[], matchPosition: number): EditResult {
  if (matchPosition === -1) {
    return { confidence: 0, result: content, strategy: 'context' };
  }

  const newResult = [...content.slice(0, matchPosition)];
  let sourceIndex = matchPosition;
  let previousIndent = '';
  let lastChangeWasRemove = false;  // Track if last change was a remove

  for (const change of hunk.changes) {

    if (change.type === 'context') {
      newResult.push(change.originalLine || (change.indent + change.content));
      previousIndent = change.indent;
      if (!lastChangeWasRemove) {  // Only increment if we didn't just remove a line
        sourceIndex++;
      }
      lastChangeWasRemove = false;
    } else if (change.type === 'add') {
      const indent = change.indent || inferIndentation(change.content, 
        hunk.changes.filter(c => c.type === 'context' && c.originalLine).map(c => c.originalLine || ''),
        previousIndent
      );
      newResult.push(indent + change.content);
      previousIndent = indent;
      lastChangeWasRemove = false;
    } else if (change.type === 'remove') {
      sourceIndex++;
      lastChangeWasRemove = true;
    }
  }

  newResult.push(...content.slice(sourceIndex));
  
  // Calculate the window size based on all changes
  const windowSize = hunk.changes.length;
  
  // Validate the result using the full window size
  const similarity = getDMPSimilarity(
    content.slice(matchPosition, matchPosition + windowSize).join('\n'),
    newResult.slice(matchPosition, matchPosition + windowSize).join('\n')
  )

  const confidence = validateEditResult(hunk, newResult.slice(matchPosition, matchPosition + windowSize).join('\n'));

  return { 
    confidence: similarity * confidence,
    result: newResult,
    strategy: 'context'
  };
}

// DMP edit strategy
export function applyDMP(hunk: Hunk, content: string[], matchPosition: number): EditResult {
  if (matchPosition === -1) {
    return { confidence: 0, result: content, strategy: 'dmp' };
  }

  const dmp = new diff_match_patch();
  
  // Calculate edit region - look for block boundaries
  let editRegionStart = matchPosition;
  let editRegionEnd = matchPosition + hunk.changes.length;
  
  // Look back for block start (e.g. enum declaration)
  for (let i = matchPosition - 1; i >= 0; i--) {
    const line = content[i]?.trim();
    if (line && (line.startsWith('export') || line.startsWith('enum') || line.endsWith('{'))) {
      editRegionStart = i;
      break;
    }
    if (line === '') break; // Stop at empty line
  }
  
  // Look ahead for block end
  for (let i = editRegionEnd; i < content.length; i++) {
    const line = content[i]?.trim();
    if (line === '}') {
      editRegionEnd = i + 1; // Include the closing brace
      break;
    }
    if (line === '') break; // Stop at empty line
  }
  
  const editRegion = content.slice(editRegionStart, editRegionEnd);
  console.log('\nDMP Debug - Edit Region:');
  console.log('editRegionStart:', editRegionStart);
  console.log('editRegionEnd:', editRegionEnd);
  console.log('editRegion:', editRegion);
  
  const editText = editRegion.join('\n');
  console.log('\nDMP Debug - Edit Text:');
  console.log(editText);
  
  // Build the target text sequentially like in applyContextMatching
  const targetLines: string[] = [];
  let previousIndent = '';
  let sourceIndex = editRegionStart;
  let lastChangeWasRemove = false;
  let blockIndent = '';
  
  // Detect block indentation from context
  for (const line of editRegion) {
    const match = line.match(/^(\s+)/);
    if (match) {
      blockIndent = match[1];
      break;
    }
  }
  
  console.log('\nDMP Debug - Processing Changes:');
  for (const change of hunk.changes) {
    console.log('\nChange:', {
      type: change.type,
      content: change.content,
      sourceIndex,
      lastChangeWasRemove
    });

    if (change.type === 'context') {
      // For context lines, preserve exact content including empty lines
      const originalLine = content[sourceIndex];
      console.log('Context line - original:', originalLine);
      if (originalLine !== undefined) {
        targetLines.push(originalLine);
        // Update block indent if this is a block start
        if (originalLine.trim().endsWith('{')) {
          blockIndent = originalLine.match(/^(\s+)/)?.[1] || '';
        }
      } else {
        targetLines.push(change.originalLine || (change.indent + change.content));
      }
      previousIndent = change.indent;
      if (!lastChangeWasRemove) {
        sourceIndex++;
      }
      lastChangeWasRemove = false;
    } else if (change.type === 'add') {
      const indent = change.indent || inferIndentation(change.content, 
        hunk.changes.filter(c => c.type === 'context' && c.originalLine).map(c => c.originalLine || ''),
        previousIndent
      );
      targetLines.push(indent + change.content);
      previousIndent = indent;
      lastChangeWasRemove = false;
    } else if (change.type === 'remove') {
      sourceIndex++;
      lastChangeWasRemove = true;
    }
    console.log('Current targetLines:', targetLines);
  }

  // Add remaining block content if we're in a block
  while (sourceIndex < editRegionEnd) {
    const line = content[sourceIndex];
    if (line !== undefined) {
      targetLines.push(line);
    }
    sourceIndex++;
  }

  const targetText = targetLines.join('\n');
  console.log('\nDMP Debug - Target Text:');
  console.log(targetText);

  const patch = dmp.patch_make(editText, targetText);
  console.log('\nDMP Debug - Patch:');
  console.log(patch);

  const [patchedText] = dmp.patch_apply(patch, editText);
  console.log('\nDMP Debug - Patched Text:');
  console.log(patchedText);
  
  // Construct result with edited portion
  const newResult = [
    ...content.slice(0, editRegionStart),
    ...patchedText.split('\n'),
    ...content.slice(editRegionEnd)
  ];

  console.log('\nDMP Debug - Result Construction:');
  console.log('Prefix:', content.slice(0, editRegionStart));
  console.log('Patched:', patchedText.split('\n'));
  console.log('Suffix:', content.slice(editRegionEnd));

  const similarity = getDMPSimilarity(editText, patchedText)
  const confidence = validateEditResult(hunk, patchedText);
  
  return { 
    confidence: similarity * confidence,
    result: newResult,
    strategy: 'dmp'
  };
}

// Git edit strategy with cherry-pick approach
async function applyGit(hunk: Hunk, content: string[], matchPosition: number): Promise<EditResult> {
  if (matchPosition === -1) {
    return { confidence: 0, result: content, strategy: 'git' };
  }

  vol.reset();
  
  try {
    // Initialize git repo
    await git.init({ fs: memfs, dir: '/' });
    
    // Create original content - only use the edit region
    const editRegion = content.slice(matchPosition, matchPosition + hunk.changes.length);
    const editText = editRegion.join('\n');
    await memfs.promises.writeFile('/file.txt', editText);
    await git.add({ fs: memfs, dir: '/', filepath: 'file.txt' });
    await git.commit({
      fs: memfs,
      dir: '/',
      author: { name: 'Temp', email: 'temp@example.com' },
      message: 'Original'
    });
    const originalHash = await git.resolveRef({ fs: memfs, dir: '/', ref: 'HEAD' });

    // Create search content (content with removals)
    const searchLines = [...editRegion];
    let offset = 0;
    for (const change of hunk.changes) {
      if (change.type === 'remove') {
        const index = searchLines.findIndex(
          (line, i) => i >= offset && line.trimLeft() === change.content
        );
        if (index !== -1) {
          searchLines.splice(index, 1);
        }
      }
      if (change.type !== 'add') {
        offset++;
      }
    }
    
    // Create search branch and commit
    await git.branch({ fs: memfs, dir: '/', ref: 'search' });
    await git.checkout({ fs: memfs, dir: '/', ref: 'search' });
    await memfs.promises.writeFile('/file.txt', searchLines.join('\n'));
    await git.add({ fs: memfs, dir: '/', filepath: 'file.txt' });
    await git.commit({
      fs: memfs,
      dir: '/',
      author: { name: 'Temp', email: 'temp@example.com' },
      message: 'Search state'
    });
    const searchHash = await git.resolveRef({ fs: memfs, dir: '/', ref: 'HEAD' });

    // Create replace content (with additions)
    const replaceLines = [...searchLines];
    offset = 0;
    const contextLines = hunk.changes
      .filter(c => c.type === 'context')
      .map(c => c.content);

    for (const change of hunk.changes) {
      if (change.type === 'add') {
        const indent = change.indent || inferIndentation(change.content, contextLines);
        replaceLines.splice(offset, 0, indent + change.content);
        offset++;
      } else if (change.type !== 'remove') {
        offset++;
      }
    }

    // Create replace branch and commit
    await git.branch({ fs: memfs, dir: '/', ref: 'replace' });
    await git.checkout({ fs: memfs, dir: '/', ref: 'replace' });
    await memfs.promises.writeFile('/file.txt', replaceLines.join('\n'));
    await git.add({ fs: memfs, dir: '/', filepath: 'file.txt' });
    await git.commit({
      fs: memfs,
      dir: '/',
      author: { name: 'Temp', email: 'temp@example.com' },
      message: 'Replace state'
    });
    const replaceHash = await git.resolveRef({ fs: memfs, dir: '/', ref: 'HEAD' });

    // Try both strategies:
    // 1. OSR: Cherry-pick replace onto original
    // 2. SR-SO: Apply search->replace changes to search->original

    // Strategy 1: OSR
    await git.checkout({ fs: memfs, dir: '/', ref: originalHash });
    try {
      await git.merge({
        fs: memfs,
        dir: '/',
        ours: originalHash,
        theirs: replaceHash,
        author: { name: 'Temp', email: 'temp@example.com' },
        message: 'Cherry-pick OSR'
      });
      const osrResult = (await memfs.promises.readFile('/file.txt')).toString();
      const osrSimilarity = getDMPSimilarity(editText, osrResult)

      const confidence = validateEditResult(hunk, osrResult);
      
      if (osrSimilarity * confidence > 0.9) {
        // Construct result with edited portion
        const newResult = [
          ...content.slice(0, matchPosition),
          ...osrResult.split('\n'),
          ...content.slice(matchPosition + hunk.changes.length)
        ];
        return {
          confidence: osrSimilarity,
          result: newResult,
          strategy: 'git-osr'
        };
      }
    } catch (error) {
      console.log('OSR strategy failed:', error);
    }

    // Strategy 2: SR-SO
    await git.checkout({ fs: memfs, dir: '/', ref: searchHash });
    try {
      // First apply original changes
      await git.merge({
        fs: memfs,
        dir: '/',
        ours: searchHash,
        theirs: originalHash,
        author: { name: 'Temp', email: 'temp@example.com' },
        message: 'Apply original changes'
      });

      // Then apply replace changes
      await git.merge({
        fs: memfs,
        dir: '/',
        ours: 'HEAD',
        theirs: replaceHash,
        author: { name: 'Temp', email: 'temp@example.com' },
        message: 'Apply replace changes'
      });

      const srsoResult = (await memfs.promises.readFile('/file.txt')).toString();
      const srsoSimilarity = getDMPSimilarity(editText, srsoResult)

      const confidence = validateEditResult(hunk, srsoResult);

      // Construct result with edited portion
      const newResult = [
        ...content.slice(0, matchPosition),
        ...srsoResult.split('\n'),
        ...content.slice(matchPosition + hunk.changes.length)
      ];
      return {
        confidence: srsoSimilarity * confidence,
        result: newResult,
        strategy: 'git-srso'
      };
    } catch (error) {
      console.log('SR-SO strategy failed:', error);
      return { confidence: 0, result: content, strategy: 'git' };
    }
  } catch (error) {
    console.log('Git strategy failed:', error);
    return { confidence: 0, result: content, strategy: 'git' };
  } finally {
    vol.reset();
  }
}

// Main edit function that tries strategies sequentially
export async function applyEdit(hunk: Hunk, content: string[], matchPosition: number, confidence: number, debug: string = 'false'): Promise<EditResult> {

  // Don't attempt any edits if confidence is too low and not in debug mode
  const MIN_CONFIDENCE = 0.9;
  if (confidence < MIN_CONFIDENCE) {
    console.log(`Search confidence (${confidence}) below minimum threshold (${MIN_CONFIDENCE}), skipping edit`);
    return { confidence: 0, result: content, strategy: 'none' };
  }

  // Try each strategy in sequence until one succeeds
  const strategies = [
    { name: 'context', apply: () => applyContextMatching(hunk, content, matchPosition) },
    { name: 'dmp', apply: () => applyDMP(hunk, content, matchPosition) },
    { name: 'git', apply: () => applyGit(hunk, content, matchPosition) }
  ];

  if (debug !== '') {
    // In debug mode, try all strategies and return the first success
    const results = await Promise.all(strategies.map(async strategy => {
      console.log(`Attempting edit with ${strategy.name} strategy...`);
      const result = await strategy.apply();
      console.log(`Strategy ${strategy.name} succeeded with confidence ${result.confidence}`);
      return result;
    }));
    
    /*const successfulResults = results.filter(result => result.confidence > MIN_CONFIDENCE);
    if (successfulResults.length > 0) {
      const bestResult = successfulResults.reduce((best, current) => 
        current.confidence > best.confidence ? current : best
      );
      return bestResult;
    }*/
    return results.find(result => result.strategy === debug) || { confidence: 0, result: content, strategy: 'none' };
  } else {
    // Normal mode - try strategies sequentially until one succeeds
    for (const strategy of strategies) {
      const result = await strategy.apply();
      if (result.confidence > MIN_CONFIDENCE) {
        return result;
      }
    }
  }

  // If all strategies fail, return failure
  return { confidence: 0, result: content, strategy: 'none' };
}
