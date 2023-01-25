/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

/**
 * @fileoverview Gathers a list of detected JS libraries and their versions.
 */

/* global window */
/* global d41d8cd98f00b204e9800998ecf8427e_LibraryDetectorTests */

import fs from 'fs';
import {createRequire} from 'module';

import log from 'lighthouse-logger';

import FRGatherer from '../base-gatherer.js';
import DevtoolsLog from './devtools-log.js';

// This is removed by rollup, because the only usage is to resolve a module path
// but that is replaced by the inline-fs plugin, leaving `require` unused.
const require = /* #__PURE__ */ createRequire(import.meta.url);

const libDetectorSource = fs.readFileSync(
  require.resolve('js-library-detector/library/libraries.js'), 'utf8');

/** @typedef {false | {version: string|number|null}} JSLibraryDetectorTestResult */
/**
 * @typedef JSLibraryDetectorTest
 * @property {string} id
 * @property {string} icon
 * @property {string} url
 * @property {string|null} npm npm module name, if applicable to library.
 * @property {function(Window): JSLibraryDetectorTestResult | Promise<JSLibraryDetectorTestResult>} test Returns false if library is not present, otherwise returns an object that contains the library version (set to null if the version is not detected).
 */

/**
 * @typedef JSLibrary
 * @property {string} id
 * @property {string} name
 * @property {string|number|null} version
 * @property {string|null} npm
 */

/**
 * Obtains a list of detected JS libraries and their versions.
 */
/* c8 ignore start */
async function detectLibraries() {
  /** @type {JSLibrary[]} */
  const libraries = [];

  // d41d8cd98f00b204e9800998ecf8427e_ is a consistent prefix used by the detect libraries
  // see https://github.com/HTTPArchive/httparchive/issues/77#issuecomment-291320900
  /** @type {Record<string, JSLibraryDetectorTest>} */
  // @ts-expect-error - injected libDetectorSource var
  const libraryDetectorTests = d41d8cd98f00b204e9800998ecf8427e_LibraryDetectorTests; // eslint-disable-line

  for (const [name, lib] of Object.entries(libraryDetectorTests)) {
    try {
      /** @type {NodeJS.Timeout|undefined} */
      let timeout;
      // Some library detections are async that can never return.
      // Guard ourselves from PROTOCL_TIMEOUT by limiting each detection to a max of 1s.
      // See https://github.com/GoogleChrome/lighthouse/issues/11124.
      const timeoutPromise = new Promise(r => timeout = setTimeout(() => r(false), 1000));

      const result = await Promise.race([lib.test(window), timeoutPromise]);
      if (timeout) clearTimeout(timeout);
      if (result) {
        libraries.push({
          id: lib.id,
          name: name,
          version: result.version,
          npm: lib.npm,
        });
      }
    } catch (e) {}
  }

  return libraries;
}
/* c8 ignore stop */

/**
 * @param {LH.Crdp.Network.Headers} headers
 * @return {LH.Artifacts.DetectedStack | undefined}
 */
function detectServer(headers) {
  const documentHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.toLowerCase()])
  );
  const SERVERS = [
    {id: 'akamai', name: 'Akamai', headers: {'x-akamai-transformed': ''}},
    {id: 'apache', name: 'Apache', headers: {server: 'apache'}},
    {id: 'cloudflare', name: 'Cloudflare', headers: {server: 'cloudflare'}},
    {id: 'litespeed', name: 'LiteSpeed', headers: {server: 'litespeed'}},
    {id: 'microsoft-iis', name: 'Microsoft IIS', headers: {server: 'microsoft-iis'}},
    {id: 'nginx', name: 'Nginx', headers: {server: 'nginx'}},
    {id: 'openresty', name: 'OpenResty', headers: {server: 'openresty'}},
    {id: 'squarespace', name: 'Squarespace', headers: {server: 'squarespace'}},
    {id: 'vercel', name: 'Vercel', headers: {server: 'vercel'}},
    {id: 'wix', name: 'WIX', headers: {'x-wix-request-id': ''}},
  ];
  for (const server of SERVERS) {
    const matched = Object.entries(server.headers).some(([header, value]) =>
       documentHeaders[header] && documentHeaders[header].startsWith(value)
    );
    if (matched) {
      return {
        detector: 'server',
        id: server.id,
        name: server.name,
      };
    }
  }
}


/** @implements {LH.Gatherer.FRGathererInstance} */
class Stacks extends FRGatherer {
  /** @type {LH.Gatherer.GathererMeta<'DevtoolsLog'>} */
  meta = {
    supportedModes: ['navigation'],
    dependencies: {DevtoolsLog: DevtoolsLog.symbol},
  };

  /**
   * @param {LH.Artifacts['DevtoolsLog']} devtoolsLog
   * @return {LH.Crdp.Network.Headers}
   */
  static getDocumentHeaders(devtoolsLog) {
    for (const entry of devtoolsLog) {
      if (entry.method !== 'Network.responseReceived') continue;
      if (entry.params.type !== 'Document') continue;
      return entry.params.response.headers;
    }
    return {};
  }

  /**
   * @param {LH.Gatherer.FRTransitionalDriver['executionContext']} executionContext
   * @param {LH.Artifacts['DevtoolsLog']} devtoolsLog
   * @return {Promise<LH.Artifacts['Stacks']>}
   */
  static async collectStacks(executionContext, devtoolsLog) {
    const status = {msg: 'Collect stacks', id: 'lh:gather:collectStacks'};
    log.time(status);

    const jsLibraries = await executionContext.evaluate(detectLibraries, {
      args: [],
      deps: [libDetectorSource],
    });

    /** @type {LH.Artifacts['Stacks']} */
    const stacks = jsLibraries.map(lib => ({
      detector: 'js',
      id: lib.id,
      name: lib.name,
      version: typeof lib.version === 'number' ? String(lib.version) : (lib.version || undefined),
      npm: lib.npm || undefined,
    }));

    const detectedServer = detectServer(Stacks.getDocumentHeaders(devtoolsLog));
    if (detectedServer) {
      stacks.push(detectedServer);
    }
    log.timeEnd(status);
    return stacks;
  }

  /**
   * @param {LH.Gatherer.FRTransitionalContext<'DevtoolsLog'>} context
   * @return {Promise<LH.Artifacts['Stacks']>}
   */
  async getArtifact(context) {
    try {
      return await Stacks.collectStacks(
        context.driver.executionContext,
        context.dependencies.DevtoolsLog
      );
    } catch {
      return [];
    }
  }
}

export default Stacks;
