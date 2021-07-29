import { resolve } from 'path'
import { createRequire } from 'module'
import { cwd } from 'process'

import { normalizePath } from 'vite'
import config from '../mfe.config.js'

const require = createRequire(import.meta.url)

const constants = {
  DIST: 'dist',
  ASSETS: 'assets',
  VENDOR: 'vendor',
  ROUTES: 'routes',
  SCOPE: '@vue-mfe'
}
const localPkgNameRegExp = new RegExp(`^${constants.SCOPE}/`)
const cached = (fn) => {
  const cache = Object.create(null)
  return (str) => cache[str] || (cache[str] = fn(str))
}
const isRoute = cached((path) => /packages\/.+?\/src\/pages\/.+(vue|tsx)/.test(getNormalizedPath(path)))
const isLocalPkg = cached((pkgName) => localPkgNameRegExp.test(pkgName))
const getNormalizedPath = cached((path) => normalizePath(path.replace(cwd(), '')).slice(1))
const getPkgId = cached((path) => path.replace(/^packages\/(.+?)\/.+/, '$1'))
const getPkgInfoFromPkgId = cached((pkgId) => require(resolve(`packages/${pkgId}/package.json`)))
const getPkgInfo = cached((path) => getPkgInfoFromPkgId(getPkgId(path)))
const getPkgConfigFromPkgId = cached((pkgId) => config.packages[pkgId])
const getPkgConfig = cached((path) => getPkgConfigFromPkgId(getPkgId(path)))
const getLocalModuleName = cached(
  (path) => {
    const pkg = getPkgInfo(path)
    const { name } = pkg
    const { type } = getPkgConfig(path)
    if (type === 'pages') {
      return path.replace(/.+?\/.+?(?=\/)/, name)
    } else {
      return name
    }
  }
)
const getAliasKeyFromPkgId = cached((pkgId) => `@${pkgId}`)
const getAliasKey = cached((path) => getAliasKeyFromPkgId(getPkgId(path)))
const getAliasFromPkgId = cached(
  (pkgId) => {
    const { type } = getPkgConfigFromPkgId(pkgId)
    const alias = []
    const aliasKey = getAliasKeyFromPkgId(pkgId)
    if (type === 'pages') {
      alias.push(
        { find: new RegExp(aliasKey + '(/.+\\.(vue|ts|tsx))'), replacement: `${constants.SCOPE}/${pkgId}/src$1` }
      )
    }
    alias.push({ find: aliasKey, replacement: resolve(`packages/${pkgId}/src`) })
    return alias
  }
)
const getAlias = cached((path) => getAliasFromPkgId(getPkgId(path)))
const getDevAlias = () => {
  const alias = {}
  Object.keys(config.packages).forEach(
    (pkgId) => (alias[getAliasKeyFromPkgId(pkgId)] = resolve(`packages/${pkgId}/src`))
  )
  return alias
}
const getExternalFromPkgId = cached(
  (pkgId) => [...Object.keys(getPkgInfoFromPkgId(pkgId).dependencies), localPkgNameRegExp]
)
const getExternal = cached((path) => getExternalFromPkgId(getPkgId(path)))

export {
  constants,
  localPkgNameRegExp,
  cached,
  isRoute,
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
  getDevAlias,
  getExternalFromPkgId,
  getExternal
}
