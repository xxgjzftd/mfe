import { resolve } from 'path'
import { readFile, writeFile, rm } from 'fs/promises'
import { createRequire } from 'module'
import { argv, exit } from 'process'

import vite from 'vite'
import vue from '@vitejs/plugin-vue'
import execa from 'execa'
import axios from 'axios'
import fg from 'fast-glob'

import { routes } from './plugins.js'
import resolvers from './resolvers/index.js'
import config from '../mfe.config.js'
import {
  constants,
  localPkgNameRegExp,
  cached,
  isLocalPkg,
  getPkgId,
  getPkgInfoFromPkgId,
  getPkgInfo,
  getPkgConfigFromPkgId,
  getPkgConfig,
  getLocalModuleName,
  getAliasKeyFromPkgId,
  getAliasKey,
  getAliasFromPkgId,
  getAlias,
  getExternalFromPkgId,
  getExternal
} from './utils.js'

const require = createRequire(import.meta.url)

const { DIST, ASSETS, VENDOR } = constants
let meta
let ossUrl
const mode = argv[2]
try {
  switch (mode) {
    case 'qa':
    case 'prod':
      ossUrl = config.oss[mode]
      meta = await axios.get(`${ossUrl}meta.json`).then((res) => res.data)
      break
    default:
      meta = require(resolve(`${DIST}/meta.json`))
      break
  }
} catch (error) {
  meta = {}
}
meta.modules = meta.modules || {}

let sources = []
if (meta.hash) {
  const { stdout } = execa.sync('git', ['diff', meta.hash, 'HEAD', '--name-status'])
  sources = stdout
    .split('\n')
    .map(
      (info) => {
        const [status, path] = info.split('\t')
        return { status, path }
      }
    )
    .filter(({ path }) => /packages\/.+?\/src\/.+/.test(path))
} else {
  sources = fg.sync('packages/*/src/**/*.{ts,tsx,vue}').map(
    (path) => {
      return { status: 'A', path }
    }
  )
}
!sources.length && exit()
meta.hash = execa.sync('git', ['rev-parse', '--short', 'HEAD']).stdout

const remove = (mn) => {
  const info = meta.modules[mn]
  const removals = []
  if (info) {
    info.js && removals.push(info.js)
    info.css && removals.push(info.css)
  }
  if (!mode) {
    removals.forEach(
      (path) =>
        rm(
          resolve(DIST, path.slice(1)),
          {
            force: true,
            recursive: true
          }
        )
    )
  }
}
const getModuleInfo = cached((mn) => (meta.modules[mn] = meta.modules[mn] || {}))
const vendorsDepInfo = {}
const setVendorsDepInfo = cached(
  (mn) => {
    const info = (vendorsDepInfo[mn] = vendorsDepInfo[mn] || {})
    const { peerDependencies } = require(`${mn}/package.json`)
    if (peerDependencies) {
      info.dependencies = Object.keys(peerDependencies)
      info.dependencies.forEach(
        (dep) => {
          const depInfo = (vendorsDepInfo[dep] = vendorsDepInfo[dep] || {})
          depInfo.dependents = depInfo.dependents || []
          depInfo.dependents.push(mn)
        }
      )
    }
    return true
  }
)
const getVendorsExports = () => {
  const vendorsExports = {}
  Object.keys(meta.modules).forEach(
    (mn) => {
      const { imports } = meta.modules[mn]
      if (imports) {
        Object.keys(imports).forEach(
          (imported) => {
            if (!isLocalPkg(imported)) {
              setVendorsDepInfo(imported)
              const bindings = (vendorsExports[imported] = vendorsExports[imported] || new Set())
              imports[imported].forEach((binding) => bindings.add(binding))
            }
          }
        )
      }
    }
  )
  Object.keys(vendorsExports).forEach(
    (vendor) => {
      vendorsExports[vendor] = Array.from(vendorsExports[vendor])
      vendorsExports[vendor].sort()
    }
  )
  return vendorsExports
}

const preVendorsExports = getVendorsExports()
const plugins = {
  meta (pathOrMN, isVendor = false) {
    return {
      name: 'vue-mfe-meta',
      generateBundle (options, bundle) {
        const mn = isVendor ? pathOrMN : getLocalModuleName(pathOrMN)
        const info = getModuleInfo(mn)
        const fileNames = Object.keys(bundle)
        const js = fileNames.find((fileName) => bundle[fileName].isEntry)
        const css = fileNames.find((fileName) => fileName.endsWith('.css'))
        info.js = `/${js}`
        css && (info.css = `/${css}`)
        const { importedBindings } = bundle[js]
        info.imports = importedBindings
      }
    }
  },
  // 如果有动态import的需求，再加上相应实现。暂时不用这个plugin。
  import () {
    return {
      name: 'vue-mfe-import',
      options (options) {
        const index = options.plugins.findIndex((plugin) => plugin.name === 'vite:import-analysis')
        if (~index) {
          options.plugins.splice(index, 1)
        } else {
          throw new Error('vite 内置插件有变动，构建结果可能有缺陷')
        }
      }
    }
  }
}

const builder = {
  async vendors (mn) {
    const info = vendorsDepInfo[mn]
    const preBindings = preVendorsExports[mn]
    let curBindings = curVendorsExports[mn]
    if (info.dependents) {
      await Promise.all(info.dependents.map((dep) => builder.vendors(dep)))
      curBindings = new Set(curBindings)
      info.dependents.forEach((dep) => meta.modules[dep].imports[mn].forEach((binding) => curBindings.add(binding)))
      curBindings = curVendorsExports[mn] = Array.from(curBindings).sort()
    }
    if (!preBindings || preBindings.toString() !== curBindings.toString()) {
      remove(mn)
      return vite.build(
        {
          configFile: false,
          publicDir: false,
          build: {
            sourcemap: true,
            minify: false,
            emptyOutDir: false,
            lib: {
              entry: resolve(VENDOR),
              fileName: `${ASSETS}/${mn}.[hash]`,
              formats: ['es']
            },
            rollupOptions: {
              external: info.dependencies
            }
          },
          plugins: [
            {
              name: 'vue-mfe-vendors',
              enforce: 'pre',
              resolveId (source, importer, options) {
                if (source === resolve(VENDOR)) {
                  return VENDOR
                }
              },
              load (id) {
                if (id === VENDOR) {
                  const resolver = resolvers[mn.replace(/-(\w)/g, (m, p1) => p1.toUpperCase())]
                  if (resolver) {
                    return curBindings
                      .map(
                        (binding) => {
                          const { path, sideEffects } = resolver(binding)
                          return `${sideEffects ? `import ${optimizedInfo.sideEffects};\n` : ''}
                            export { default as ${binding} } from "${mn}/${path}";`
                        }
                      )
                      .join('\n')
                  } else {
                    return `export { ${curBindings.toString()} } from "${mn}";`
                  }
                }
              }
            },
            plugins.meta(mn, true)
          ]
        }
      )
    }
  },
  // utils components pages
  async lib (path) {
    return vite.build(
      {
        configFile: false,
        publicDir: false,
        resolve: {
          alias: getAlias(path)
        },
        build: {
          sourcemap: true,
          minify: false,
          emptyOutDir: false,
          rollupOptions: {
            input: resolve(path),
            output: {
              entryFileNames: `${ASSETS}/[name]-[hash].js`,
              chunkFileNames: `${ASSETS}/[name]-[hash].js`,
              assetFileNames: `${ASSETS}/[name]-[hash][extname]`,
              format: 'es'
            },
            preserveEntrySignatures: 'allow-extension',
            external: getExternal(path)
          }
        },
        plugins: [vue(), plugins.meta(path)]
      }
    )
  },
  async container (path) {
    return vite.build(
      {
        configFile: false,
        resolve: {
          alias: getAlias(path)
        },
        build: {
          sourcemap: true,
          minify: false,
          emptyOutDir: false,
          rollupOptions: {
            external: getExternal(path)
          }
        },
        plugins: [vue(), plugins.meta(path), routes()]
      }
    )
  }
}

let containerName = ''
const built = new Set()
const build = async ({ path, status }) => {
  const pkg = getPkgInfo(path)
  const {
    name,
    main,
    mfe: { type }
  } = pkg
  if (status !== 'A') {
    remove(getLocalModuleName(path))
  }
  switch (type) {
    case 'pages':
      return builder.lib(path)
    case 'components':
    case 'utils':
    case 'container':
      return (
        built.has(name) ||
        (built.add(name),
        builder[type === 'container' ? ((containerName = name), type) : 'lib'](path.replace(/(?<=(.+?\/){2}).+/, main)))
      )
    default:
      throw new Error(`${name} type 未指定`)
  }
}

await Promise.all(sources.map(build))

const curVendorsExports = getVendorsExports()
Object.keys(preVendorsExports).forEach(
  (vendor) => {
    if (!(vendor in curVendorsExports)) {
      remove(vendor)
    }
  }
)

await Promise.all(
  Object.keys(curVendorsExports)
    .filter((vendor) => !vendorsDepInfo[vendor].dependencies)
    .map((vendor) => builder.vendors(vendor))
)
await Promise.all(
  [
    writeFile(resolve(`${DIST}/meta.json`), JSON.stringify(meta, 2)),
    (built.has(containerName) || !mode
      ? readFile(resolve(`${DIST}/index.html`), { encoding: 'utf8' })
      : axios.get(`${ossUrl}index.html`).then((res) => res.data)
    ).then(
      (html) => {
        let importmap = { imports: {} }
        const imports = importmap.imports
        Object.keys(meta.modules).forEach((mn) => (imports[mn] = meta.modules[mn].js))
        importmap = `<script type="importmap">${JSON.stringify(importmap)}</script>`
        let modules = `<script>window.mfe = window.mfe || {};window.mfe.modules = ${JSON.stringify(
          meta.modules
        )}</script>`
        return writeFile(
          resolve(`${DIST}/index.html`),
          html.replace(
            built.has(containerName)
              ? '<!-- mfe placeholder -->'
              : /\<script type="importmap"\>.+?\<script\>window\.mfe.+?<\/script\>/,
            importmap + modules
          )
        )
      }
    )
  ]
)

// TODO: refactor
// TODO: route watch
