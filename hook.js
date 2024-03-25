// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

const { randomBytes } = require('crypto')
const specifiers = new Map()
const isWin = process.platform === 'win32'

// FIXME: Typescript extensions are added temporarily until we find a better
// way of supporting arbitrary extensions
const EXTENSION_RE = /\.(js|mjs|cjs|ts|mts|cts)$/
const NODE_VERSION = process.versions.node.split('.')
const NODE_MAJOR = Number(NODE_VERSION[0])
const NODE_MINOR = Number(NODE_VERSION[1])

let entrypoint

let getExports
if (NODE_MAJOR >= 20 || (NODE_MAJOR === 18 && NODE_MINOR >= 19)) {
  getExports = require('./lib/get-exports.js')
} else {
  getExports = ({ url }) => import(url).then(Object.keys)
}

function hasIitm (url) {
  try {
    return new URL(url).searchParams.has('iitm')
  } catch {
    return false
  }
}

function isIitm (url, meta) {
  return url === meta.url || url === meta.url.replace('hook.mjs', 'hook.js')
}

function deleteIitm (url) {
  let resultUrl
  try {
    const urlObj = new URL(url)
    if (urlObj.searchParams.has('iitm')) {
      urlObj.searchParams.delete('iitm')
      resultUrl = urlObj.href
      if (resultUrl.startsWith('file:node:')) {
        resultUrl = resultUrl.replace('file:', '')
      }
      if (resultUrl.startsWith('file:///node:')) {
        resultUrl = resultUrl.replace('file:///', '')
      }
    } else {
      resultUrl = urlObj.href
    }
  } catch {
    resultUrl = url
  }
  return resultUrl
}

function isNodeMajor16AndMinor17OrGreater () {
  return NODE_MAJOR === 16 && NODE_MINOR >= 17
}

function isFileProtocol (urlObj) {
  return urlObj.protocol === 'file:'
}

function isNodeProtocol (urlObj) {
  return urlObj.protocol === 'node:'
}

function needsToAddFileProtocol (urlObj) {
  if (NODE_MAJOR === 17) {
    return !isFileProtocol(urlObj)
  }
  if (isNodeMajor16AndMinor17OrGreater()) {
    return !isFileProtocol(urlObj) && !isNodeProtocol(urlObj)
  }
  return !isFileProtocol(urlObj) && NODE_MAJOR < 18
}

/**
 * Determines if a specifier represents an export all ESM line.
 * Note that the expected `line` isn't 100% valid ESM. It is derived
 * from the `getExports` function wherein we have recognized the true
 * line and re-mapped it to one we expect.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isStarExportLine (line) {
  return /^\* from /.test(line)
}

/**
 * @typedef {object} ProcessedModule
 * @property {string[]} imports A set of ESM import lines to be added to the
 * shimmed module source.
 * @property {string[]} namespaces A set of identifiers representing the
 * modules in `imports`, e.g. for `import * as foo from 'bar'`, "foo" will be
 * present in this array.
 * @property {Map<string, string>} setters The shimmed setters for all the
 * exports from the module and any transitive export all modules. The key is
 * used to deduplicate conflicting exports, assigning a priority to `default`
 * exports.
 */

/**
 * Processes a module's exports and builds a set of new import statements,
 * namespace names, and setter blocks. If an export all export if encountered,
 * the target exports will be hoisted to the current module via a generated
 * namespace.
 *
 * @param {object} params
 * @param {string} params.srcUrl The full URL to the module to process.
 * @param {object} params.context Provided by the loaders API.
 * @param {Function} params.parentGetSource Provides the source code for the
 * parent module.
 * @param {string} [params.ns='namespace'] A string identifier that will be
 * used as the namespace for the identifiers exported by the module.
 * @param {string} [params.defaultAs='default'] The name to give the default
 * identifier exported by the module (if one exists). This is really only
 * useful in a recursive situation where a transitive module's default export
 * needs to be renamed to the name of the module.
 *
 * @returns {Promise<ProcessedModule>}
 */
async function processModule ({
  srcUrl,
  context,
  parentGetSource,
  ns = 'namespace',
  defaultAs = 'default'
}) {
  const exportNames = await getExports({
    url: srcUrl,
    context,
    parentLoad: parentGetSource,
    defaultAs
  })
  const imports = [`import * as ${ns} from ${JSON.stringify(srcUrl)}`]
  const namespaces = [ns]

  // As we iterate found module exports we will add setter code blocks
  // to this map that will eventually be inserted into the shim module's
  // source code. We utilize a map in order to prevent duplicate exports.
  // As a consequence of default renaming, it is possible that a file named
  // `foo.mjs` which has `export function foo() {}` and `export default foo`
  // exports will result in the "foo" export being defined twice in our shim.
  // The map allows us to avoid this situation at the cost of losing the
  // named export in favor of the default export.
  const setters = new Map()

  for (const n of exportNames) {
    if (isStarExportLine(n) === true) {
      const [, modFile] = n.split('* from ')
      const normalizedModName = normalizeModName(modFile)
      const modUrl = new URL(modFile, srcUrl).toString()
      const modName = Buffer.from(modFile, 'hex') + Date.now() + randomBytes(4).toString('hex')

      const data = await processModule({
        srcUrl: modUrl,
        context,
        parentGetSource,
        ns: `$${modName}`,
        defaultAs: normalizedModName
      })
      Array.prototype.push.apply(imports, data.imports)
      Array.prototype.push.apply(namespaces, data.namespaces)
      for (const [k, v] of data.setters.entries()) {
        setters.set(k, v)
      }

      continue
    }

    const matches = /^rename (.+) as (.+)$/.exec(n)
    if (matches !== null) {
      // Transitive modules that export a default identifier need to have
      // that identifier renamed to the name of module. And our shim setter
      // needs to utilize that new name while being initialized from the
      // corresponding origin namespace.
      const renamedExport = matches[2]
      setters.set(`$${renamedExport}${ns}`, `
      let $${renamedExport} = ${ns}.default
      export { $${renamedExport} as ${renamedExport} }
      set.${renamedExport} = (v) => {
        $${renamedExport} = v
        return true
      }
      `)
      continue
    }

    setters.set(`$${n}` + ns, `
    let $${n} = ${ns}.${n}
    export { $${n} as ${n} }
    set.${n} = (v) => {
      $${n} = v
      return true
    }
    `)
  }

  return { imports, namespaces, setters }
}

/**
 * Given a module name, e.g. 'foo-bar' or './foo-bar.js', normalize it to a
 * string that is a valid JavaScript identifier, e.g. `fooBar`. Normalization
 * means converting kebab-case to camelCase while removing any path tokens and
 * file extensions.
 *
 * @param {string} name The module name to normalize.
 *
 * @returns {string} The normalized identifier.
 */
function normalizeModName (name) {
  return name
    .split('/')
    .pop()
    .replace(/(.+)\.(?:js|mjs)$/, '$1')
    .replaceAll(/(-.)/g, x => x[1].toUpperCase())
}

function addIitm (url) {
  const urlObj = new URL(url)
  urlObj.searchParams.set('iitm', 'true')
  return needsToAddFileProtocol(urlObj) ? 'file:' + urlObj.href : urlObj.href
}

function createHook (meta) {
  async function resolve (specifier, context, parentResolve) {
    const { parentURL = '' } = context
    const newSpecifier = deleteIitm(specifier)
    if (isWin && parentURL.indexOf('file:node') === 0) {
      context.parentURL = ''
    }
    const url = await parentResolve(newSpecifier, context, parentResolve)
    if (parentURL === '' && !EXTENSION_RE.test(url.url)) {
      entrypoint = url.url
      return { url: url.url, format: 'commonjs' }
    }

    if (isIitm(parentURL, meta) || hasIitm(parentURL)) {
      return url
    }

    // Node.js v21 renames importAssertions to importAttributes
    if (
      (context.importAssertions && context.importAssertions.type === 'json') ||
      (context.importAttributes && context.importAttributes.type === 'json')
    ) {
      return url
    }

    specifiers.set(url.url, specifier)

    return {
      url: addIitm(url.url),
      shortCircuit: true,
      format: url.format
    }
  }

  const iitmURL = new URL('lib/register.js', meta.url).toString()
  async function getSource (url, context, parentGetSource) {
    if (hasIitm(url)) {
      const realUrl = deleteIitm(url)
      const { imports, namespaces, setters: mapSetters } = await processModule({
        srcUrl: realUrl,
        context,
        parentGetSource
      })
      const setters = Array.from(mapSetters.values())

      // When we encounter modules that re-export all identifiers from other
      // modules, it is possible that the transitive modules export a default
      // identifier. Due to us having to merge all transitive modules into a
      // single common namespace, we need to recognize these default exports
      // and remap them to a name based on the module name. This prevents us
      // from overriding the top-level module's (the one actually being imported
      // by some source code) default export when we merge the namespaces.
      const renamedDefaults = setters
        .map(s => {
          const matches = /let \$(.+) = (\$.+)\.default/.exec(s)
          if (matches === null) return undefined
          return `_['${matches[1]}'] = ${matches[2]}.default`
        })
        .filter(s => s)

      // The for loops are how we merge namespaces into a common namespace that
      // can be proxied. We can't use a simple `Object.assign` style merging
      // because transitive modules can export a default identifier that would
      // override the desired default identifier. So we need to do manual
      // merging with some logic around default identifiers.
      //
      // Additionally, we need to make sure any renamed default exports in
      // transitive dependencies are added to the common namespace. This is
      // accomplished through the `renamedDefaults` array.
      return {
        source: `
import { register } from '${iitmURL}'
${imports.join('\n')}

const namespaces = [${namespaces.join(', ')}]
const _ = {}
const set = {}

const primary = namespaces.shift()
for (const [k, v] of Object.entries(primary)) {
  _[k] = v
}
for (const k of Object.getOwnPropertySymbols(primary)) {
  _[k] = primary[k]
}
for (const ns of namespaces) {
  for (const [k, v] of Object.entries(ns)) {
    if (k === 'default') continue
    _[k] = v
  }
}

${setters.join('\n')}
${renamedDefaults.join('\n')}

register(${JSON.stringify(realUrl)}, _, set, ${JSON.stringify(specifiers.get(realUrl))})
`
      }
    }

    return parentGetSource(url, context, parentGetSource)
  }

  // For Node.js 16.12.0 and higher.
  async function load (url, context, parentLoad) {
    if (hasIitm(url)) {
      const { source } = await getSource(url, context, parentLoad)
      return {
        source,
        shortCircuit: true,
        format: 'module'
      }
    }

    return parentLoad(url, context, parentLoad)
  }

  if (NODE_MAJOR >= 17 || (NODE_MAJOR === 16 && NODE_MINOR >= 12)) {
    return { load, resolve }
  } else {
    return {
      load,
      resolve,
      getSource,
      getFormat (url, context, parentGetFormat) {
        if (hasIitm(url)) {
          return {
            format: 'module'
          }
        }
        if (url === entrypoint) {
          return {
            format: 'commonjs'
          }
        }

        return parentGetFormat(url, context, parentGetFormat)
      }
    }
  }
}

module.exports = { createHook }
