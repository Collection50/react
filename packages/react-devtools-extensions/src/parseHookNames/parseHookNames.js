/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {parse} from '@babel/parser';
import LRU from 'lru-cache';
import {SourceMapConsumer} from 'source-map-js';
import {getHookName} from '../astUtils';
import {areSourceMapsAppliedToErrors} from '../ErrorTester';
import {__DEBUG__} from 'react-devtools-shared/src/constants';
import {getHookSourceLocationKey} from 'react-devtools-shared/src/hookNamesCache';
import {sourceMapIncludesSource} from '../SourceMapUtils';
import {SourceMapMetadataConsumer} from '../SourceMapMetadataConsumer';

import type {
  HooksNode,
  HookSource,
  HooksTree,
} from 'react-debug-tools/src/ReactDebugHooks';
import type {HookNames, LRUCache} from 'react-devtools-shared/src/types';
import type {Thenable} from 'shared/ReactTypes';
import type {SourceConsumer} from '../astUtils';

const MAX_SOURCE_LENGTH = 100_000_000;

type AST = mixed;

type HookSourceData = {|
  // Generated by react-debug-tools.
  hookSource: HookSource,

  // API for consuming metadfata present in extended source map.
  metadataConsumer: SourceMapMetadataConsumer | null,

  // AST for original source code; typically comes from a consumed source map.
  originalSourceAST: AST | null,

  // Source code (React components or custom hooks) containing primitive hook calls.
  // If no source map has been provided, this code will be the same as runtimeSourceCode.
  originalSourceCode: string | null,

  // Original source URL if there is a source map, or the same as runtimeSourceURL.
  originalSourceURL: string | null,

  // Compiled code (React components or custom hooks) containing primitive hook calls.
  runtimeSourceCode: string | null,

  // Same as hookSource.fileName but guaranteed to be non-null.
  runtimeSourceURL: string,

  // APIs from source-map for parsing source maps (if detected).
  sourceConsumer: SourceConsumer | null,

  // External URL of source map.
  // Sources without source maps (or with inline source maps) won't have this.
  sourceMapURL: string | null,
|};

type CachedRuntimeCodeMetadata = {|
  sourceConsumer: SourceConsumer | null,
  metadataConsumer: SourceMapMetadataConsumer | null,
|};

const runtimeURLToMetadataCache: LRUCache<
  string,
  CachedRuntimeCodeMetadata,
> = new LRU({
  max: 50,
  dispose: (runtimeSourceURL: string, metadata: CachedRuntimeCodeMetadata) => {
    if (__DEBUG__) {
      console.log(
        `runtimeURLToMetadataCache.dispose() Evicting cached metadata for "${runtimeSourceURL}"`,
      );
    }

    const sourceConsumer = metadata.sourceConsumer;
    if (sourceConsumer !== null) {
      sourceConsumer.destroy();
    }
  },
});

type CachedSourceCodeMetadata = {|
  originalSourceAST: AST,
  originalSourceCode: string,
|};

const originalURLToMetadataCache: LRUCache<
  string,
  CachedSourceCodeMetadata,
> = new LRU({
  max: 50,
  dispose: (originalSourceURL: string, metadata: CachedSourceCodeMetadata) => {
    if (__DEBUG__) {
      console.log(
        `originalURLToMetadataCache.dispose() Evicting cached metadata for "${originalSourceURL}"`,
      );
    }
  },
});

export async function parseHookNames(
  hooksTree: HooksTree,
): Thenable<HookNames | null> {
  const hooksList: Array<HooksNode> = [];
  flattenHooksList(hooksTree, hooksList);

  if (__DEBUG__) {
    console.log('parseHookNames() hooksList:', hooksList);
  }

  // Create map of unique source locations (file names plus line and column numbers) to metadata about hooks.
  const locationKeyToHookSourceData: Map<string, HookSourceData> = new Map();
  for (let i = 0; i < hooksList.length; i++) {
    const hook = hooksList[i];

    const hookSource = hook.hookSource;
    if (hookSource == null) {
      // Older versions of react-debug-tools don't include this information.
      // In this case, we can't continue.
      throw Error('Hook source code location not found.');
    }

    const locationKey = getHookSourceLocationKey(hookSource);
    if (!locationKeyToHookSourceData.has(locationKey)) {
      // Can't be null because getHookSourceLocationKey() would have thrown
      const runtimeSourceURL = ((hookSource.fileName: any): string);

      const hookSourceData: HookSourceData = {
        hookSource,
        metadataConsumer: null,
        originalSourceAST: null,
        originalSourceCode: null,
        originalSourceURL: null,
        runtimeSourceCode: null,
        runtimeSourceURL,
        sourceConsumer: null,
        sourceMapURL: null,
      };

      // If we've already loaded the source map info for this file,
      // we can skip reloading it (and more importantly, re-parsing it).
      const runtimeMetadata = runtimeURLToMetadataCache.get(
        hookSourceData.runtimeSourceURL,
      );
      if (runtimeMetadata != null) {
        if (__DEBUG__) {
          console.groupCollapsed(
            `parseHookNames() Found cached runtime metadata for file "${hookSourceData.runtimeSourceURL}"`,
          );
          console.log(runtimeMetadata);
          console.groupEnd();
        }
        hookSourceData.sourceConsumer = runtimeMetadata.sourceConsumer;
        hookSourceData.metadataConsumer = runtimeMetadata.metadataConsumer;
      }

      locationKeyToHookSourceData.set(locationKey, hookSourceData);
    }
  }

  return loadSourceFiles(locationKeyToHookSourceData)
    .then(() => extractAndLoadSourceMaps(locationKeyToHookSourceData))
    .then(() => parseSourceAST(locationKeyToHookSourceData))
    .then(() => updateLruCache(locationKeyToHookSourceData))
    .then(() => findHookNames(hooksList, locationKeyToHookSourceData));
}

function decodeBase64String(encoded: string): Object {
  if (typeof atob === 'function') {
    return atob(encoded);
  } else if (
    typeof Buffer !== 'undefined' &&
    Buffer !== null &&
    typeof Buffer.from === 'function'
  ) {
    return Buffer.from(encoded, 'base64');
  } else {
    throw Error('Cannot decode base64 string');
  }
}

function extractAndLoadSourceMaps(
  locationKeyToHookSourceData: Map<string, HookSourceData>,
): Promise<*> {
  // SourceMapConsumer.initialize() does nothing when running in Node (aka Jest)
  // because the wasm file is automatically read from the file system
  // so we can avoid triggering a warning message about this.
  if (!__TEST__) {
    if (__DEBUG__) {
      console.log(
        'extractAndLoadSourceMaps() Initializing source-map library ...',
      );
    }
  }

  // Deduplicate fetches, since there can be multiple location keys per source map.
  const fetchPromises = new Map();

  const setPromises = [];
  locationKeyToHookSourceData.forEach(hookSourceData => {
    if (
      hookSourceData.sourceConsumer != null &&
      hookSourceData.metadataConsumer != null
    ) {
      // Use cached source map and metadata consumers.
      return;
    }

    const sourceMapRegex = / ?sourceMappingURL=([^\s'"]+)/gm;
    const runtimeSourceCode = ((hookSourceData.runtimeSourceCode: any): string);
    let sourceMappingURLMatch = sourceMapRegex.exec(runtimeSourceCode);
    if (sourceMappingURLMatch == null) {
      // Maybe file has not been transformed; we'll try to parse it as-is in parseSourceAST().

      if (__DEBUG__) {
        console.log('extractAndLoadSourceMaps() No source map found');
      }
    } else {
      const externalSourceMapURLs = [];
      while (sourceMappingURLMatch != null) {
        const {runtimeSourceURL} = hookSourceData;
        const sourceMappingURL = sourceMappingURLMatch[1];
        const hasInlineSourceMap = sourceMappingURL.indexOf('base64,') >= 0;
        if (hasInlineSourceMap) {
          // TODO (named hooks) deduplicate parsing in this branch (similar to fetching in the other branch)
          // since there can be multiple location keys per source map.

          // Web apps like Code Sandbox embed multiple inline source maps.
          // In this case, we need to loop through and find the right one.
          // We may also need to trim any part of this string that isn't based64 encoded data.
          const trimmed = ((sourceMappingURL.match(
            /base64,([a-zA-Z0-9+\/=]+)/,
          ): any): Array<string>)[1];
          const decoded = decodeBase64String(trimmed);
          const parsed = JSON.parse(decoded);

          if (__DEBUG__) {
            console.groupCollapsed(
              'extractAndLoadSourceMaps() Inline source map',
            );
            console.log(parsed);
            console.groupEnd();
          }

          // Hook source might be a URL like "https://4syus.csb.app/src/App.js"
          // Parsed source map might be a partial path like "src/App.js"
          if (sourceMapIncludesSource(parsed, runtimeSourceURL)) {
            hookSourceData.metadataConsumer = new SourceMapMetadataConsumer(
              parsed,
            );
            hookSourceData.sourceConsumer = new SourceMapConsumer(parsed);
            break;
          }
        } else {
          externalSourceMapURLs.push(sourceMappingURL);
        }

        sourceMappingURLMatch = sourceMapRegex.exec(runtimeSourceCode);
      }

      const foundInlineSourceMap =
        hookSourceData.sourceConsumer != null &&
        hookSourceData.metadataConsumer != null;
      if (!foundInlineSourceMap) {
        externalSourceMapURLs.forEach((sourceMappingURL, index) => {
          if (index !== externalSourceMapURLs.length - 1) {
            // Files with external source maps should only have a single source map.
            // More than one result might indicate an edge case,
            // like a string in the source code that matched our "sourceMappingURL" regex.
            // We should just skip over cases like this.
            console.warn(
              `More than one external source map detected in the source file; skipping "${sourceMappingURL}"`,
            );
            return;
          }

          const {runtimeSourceURL} = hookSourceData;
          let url = sourceMappingURL;
          if (!url.startsWith('http') && !url.startsWith('/')) {
            // Resolve paths relative to the location of the file name
            const lastSlashIdx = runtimeSourceURL.lastIndexOf('/');
            if (lastSlashIdx !== -1) {
              const baseURL = runtimeSourceURL.slice(
                0,
                runtimeSourceURL.lastIndexOf('/'),
              );
              url = `${baseURL}/${url}`;
            }
          }

          hookSourceData.sourceMapURL = url;

          const fetchPromise =
            fetchPromises.get(url) ||
            fetchFile(url).then(
              sourceMapContents => {
                const parsed = JSON.parse(sourceMapContents);
                return {
                  sourceConsumer: new SourceMapConsumer(parsed),
                  metadataConsumer: new SourceMapMetadataConsumer(parsed),
                };
              },
              // In this case, we fall back to the assumption that the source has no source map.
              // This might indicate an (unlikely) edge case that had no source map,
              // but contained the string "sourceMappingURL".
              error => null,
            );

          if (__DEBUG__) {
            if (!fetchPromises.has(url)) {
              console.log(
                `extractAndLoadSourceMaps() External source map "${url}"`,
              );
            }
          }

          fetchPromises.set(url, fetchPromise);
          setPromises.push(
            fetchPromise.then(result => {
              hookSourceData.metadataConsumer =
                result?.metadataConsumer ?? null;
              hookSourceData.sourceConsumer = result?.sourceConsumer ?? null;
            }),
          );
        });
      }
    }
  });
  return Promise.all(setPromises);
}

function fetchFile(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fetch(url).then(
      response => {
        if (response.ok) {
          response
            .text()
            .then(text => {
              resolve(text);
            })
            .catch(error => {
              if (__DEBUG__) {
                console.log(`fetchFile() Could not read text for url "${url}"`);
              }
              reject(null);
            });
        } else {
          if (__DEBUG__) {
            console.log(`fetchFile() Got bad response for url "${url}"`);
          }
          reject(null);
        }
      },
      error => {
        if (__DEBUG__) {
          console.log(`fetchFile() Could not fetch file: ${error.message}`);
        }
        reject(null);
      },
    );
  });
}

function findHookNames(
  hooksList: Array<HooksNode>,
  locationKeyToHookSourceData: Map<string, HookSourceData>,
): HookNames {
  const map: HookNames = new Map();

  hooksList.map(hook => {
    // We already guard against a null HookSource in parseHookNames()
    const hookSource = ((hook.hookSource: any): HookSource);
    const fileName = hookSource.fileName;
    if (!fileName) {
      return null; // Should not be reachable.
    }

    const locationKey = getHookSourceLocationKey(hookSource);
    const hookSourceData = locationKeyToHookSourceData.get(locationKey);
    if (!hookSourceData) {
      return null; // Should not be reachable.
    }

    const {lineNumber, columnNumber} = hookSource;
    if (!lineNumber || !columnNumber) {
      return null; // Should not be reachable.
    }

    const {originalSourceURL, sourceConsumer} = hookSourceData;

    let originalSourceColumnNumber;
    let originalSourceLineNumber;
    if (areSourceMapsAppliedToErrors() || !sourceConsumer) {
      // Either the current environment automatically applies source maps to errors,
      // or the current code had no source map to begin with.
      // Either way, we don't need to convert the Error stack frame locations.
      originalSourceColumnNumber = columnNumber;
      originalSourceLineNumber = lineNumber;
    } else {
      const position = sourceConsumer.originalPositionFor({
        line: lineNumber,

        // Column numbers are represented differently between tools/engines.
        // Error.prototype.stack columns are 1-based (like most IDEs) but ASTs are 0-based.
        // For more info see https://github.com/facebook/react/issues/21792#issuecomment-873171991
        column: columnNumber - 1,
      });

      originalSourceColumnNumber = position.column;
      originalSourceLineNumber = position.line;
    }

    if (__DEBUG__) {
      console.log(
        `findHookNames() mapped line ${lineNumber}->${originalSourceLineNumber} and column ${columnNumber}->${originalSourceColumnNumber}`,
      );
    }

    if (
      originalSourceLineNumber == null ||
      originalSourceColumnNumber == null ||
      originalSourceURL == null
    ) {
      return null;
    }

    let name;
    const {metadataConsumer} = hookSourceData;
    if (metadataConsumer != null) {
      name = metadataConsumer.hookNameFor({
        line: originalSourceLineNumber,
        column: originalSourceColumnNumber,
        source: originalSourceURL,
      });
    }

    if (name == null) {
      name = getHookName(
        hook,
        hookSourceData.originalSourceAST,
        ((hookSourceData.originalSourceCode: any): string),
        ((originalSourceLineNumber: any): number),
        originalSourceColumnNumber,
      );
    }

    if (__DEBUG__) {
      console.log(`findHookNames() Found name "${name || '-'}"`);
    }

    const key = getHookSourceLocationKey(hookSource);
    map.set(key, name);
  });

  return map;
}

function loadSourceFiles(
  locationKeyToHookSourceData: Map<string, HookSourceData>,
): Promise<*> {
  // Deduplicate fetches, since there can be multiple location keys per file.
  const fetchPromises = new Map();

  const setPromises = [];
  locationKeyToHookSourceData.forEach(hookSourceData => {
    const {runtimeSourceURL} = hookSourceData;
    const fetchPromise =
      fetchPromises.get(runtimeSourceURL) ||
      fetchFile(runtimeSourceURL).then(runtimeSourceCode => {
        if (runtimeSourceCode.length > MAX_SOURCE_LENGTH) {
          throw Error('Source code too large to parse');
        }
        if (__DEBUG__) {
          console.groupCollapsed(
            `loadSourceFiles() runtimeSourceURL "${runtimeSourceURL}"`,
          );
          console.log(runtimeSourceCode);
          console.groupEnd();
        }
        return runtimeSourceCode;
      });
    fetchPromises.set(runtimeSourceURL, fetchPromise);
    setPromises.push(
      fetchPromise.then(runtimeSourceCode => {
        hookSourceData.runtimeSourceCode = runtimeSourceCode;
      }),
    );
  });
  return Promise.all(setPromises);
}

async function parseSourceAST(
  locationKeyToHookSourceData: Map<string, HookSourceData>,
): Promise<*> {
  locationKeyToHookSourceData.forEach(hookSourceData => {
    if (hookSourceData.originalSourceAST !== null) {
      // Use cached metadata.
      return;
    }

    const {metadataConsumer, sourceConsumer} = hookSourceData;
    const runtimeSourceCode = ((hookSourceData.runtimeSourceCode: any): string);
    let hasHookMap = false;
    let originalSourceURL;
    let originalSourceCode;
    if (sourceConsumer !== null) {
      // Parse and extract the AST from the source map.
      const {lineNumber, columnNumber} = hookSourceData.hookSource;
      if (lineNumber == null || columnNumber == null) {
        throw Error('Hook source code location not found.');
      }
      // Now that the source map has been loaded,
      // extract the original source for later.
      const {source} = sourceConsumer.originalPositionFor({
        line: lineNumber,

        // Column numbers are represented differently between tools/engines.
        // Error.prototype.stack columns are 1-based (like most IDEs) but ASTs are 0-based.
        // For more info see https://github.com/facebook/react/issues/21792#issuecomment-873171991
        column: columnNumber - 1,
      });

      if (source == null) {
        // TODO (named hooks) maybe fall back to the runtime source instead of throwing?
        throw new Error(
          'Could not map hook runtime location to original source location',
        );
      }

      // TODO (named hooks) maybe canonicalize this URL somehow?
      // It can be relative if the source map specifies it that way,
      // but we use it as a cache key across different source maps and there can be collisions.
      originalSourceURL = (source: string);
      originalSourceCode = (sourceConsumer.sourceContentFor(
        source,
        true,
      ): string);

      if (__DEBUG__) {
        console.groupCollapsed(
          'parseSourceAST() Extracted source code from source map',
        );
        console.log(originalSourceCode);
        console.groupEnd();
      }

      if (
        metadataConsumer != null &&
        metadataConsumer.hasHookMap(originalSourceURL)
      ) {
        hasHookMap = true;
      }
    } else {
      // There's no source map to parse here so we can just parse the original source itself.
      originalSourceCode = runtimeSourceCode;
      // TODO (named hooks) This mixes runtimeSourceURLs with source mapped URLs in the same cache key space.
      // Namespace them?
      originalSourceURL = hookSourceData.runtimeSourceURL;
    }

    hookSourceData.originalSourceCode = originalSourceCode;
    hookSourceData.originalSourceURL = originalSourceURL;

    if (hasHookMap) {
      // If there's a hook map present from an extended sourcemap then
      // we don't need to parse the source files and instead can use the
      // hook map to extract hook names.
      return;
    }

    // The cache also serves to deduplicate parsing by URL in our loop over
    // location keys. This may need to change if we switch to async parsing.
    const sourceMetadata = originalURLToMetadataCache.get(originalSourceURL);
    if (sourceMetadata != null) {
      if (__DEBUG__) {
        console.groupCollapsed(
          `parseSourceAST() Found cached source metadata for "${originalSourceURL}"`,
        );
        console.log(sourceMetadata);
        console.groupEnd();
      }
      hookSourceData.originalSourceAST = sourceMetadata.originalSourceAST;
      hookSourceData.originalSourceCode = sourceMetadata.originalSourceCode;
    } else {
      // TypeScript is the most commonly used typed JS variant so let's default to it
      // unless we detect explicit Flow usage via the "@flow" pragma.
      const plugin =
        originalSourceCode.indexOf('@flow') > 0 ? 'flow' : 'typescript';

      // TODO (named hooks) Parsing should ideally be done off of the main thread.
      const originalSourceAST = parse(originalSourceCode, {
        sourceType: 'unambiguous',
        plugins: ['jsx', plugin],
      });
      hookSourceData.originalSourceAST = originalSourceAST;
      if (__DEBUG__) {
        console.log(
          `parseSourceAST() Caching source metadata for "${originalSourceURL}"`,
        );
      }
      originalURLToMetadataCache.set(originalSourceURL, {
        originalSourceAST,
        originalSourceCode,
      });
    }
  });
  return Promise.resolve();
}

function flattenHooksList(
  hooksTree: HooksTree,
  hooksList: Array<HooksNode>,
): void {
  for (let i = 0; i < hooksTree.length; i++) {
    const hook = hooksTree[i];

    if (isUnnamedBuiltInHook(hook)) {
      // No need to load source code or do any parsing for unnamed hooks.
      if (__DEBUG__) {
        console.log('flattenHooksList() Skipping unnamed hook', hook);
      }
      continue;
    }

    hooksList.push(hook);
    if (hook.subHooks.length > 0) {
      flattenHooksList(hook.subHooks, hooksList);
    }
  }
}

// Determines whether incoming hook is a primitive hook that gets assigned to variables.
function isUnnamedBuiltInHook(hook: HooksNode) {
  return ['Effect', 'ImperativeHandle', 'LayoutEffect', 'DebugValue'].includes(
    hook.name,
  );
}

function updateLruCache(
  locationKeyToHookSourceData: Map<string, HookSourceData>,
): Promise<*> {
  locationKeyToHookSourceData.forEach(
    ({metadataConsumer, sourceConsumer, runtimeSourceURL}) => {
      // Only set once to avoid triggering eviction/cleanup code.
      if (!runtimeURLToMetadataCache.has(runtimeSourceURL)) {
        if (__DEBUG__) {
          console.log(
            `updateLruCache() Caching runtime metadata for "${runtimeSourceURL}"`,
          );
        }

        runtimeURLToMetadataCache.set(runtimeSourceURL, {
          metadataConsumer,
          sourceConsumer,
        });
      }
    },
  );
  return Promise.resolve();
}

export function purgeCachedMetadata(): void {
  originalURLToMetadataCache.reset();
  runtimeURLToMetadataCache.reset();
}