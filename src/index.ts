import type { ObjectProperty, StringLiteral } from '@babel/types'
import type { DecorationOptions, Selection } from 'vscode'
import type { JumpLocationParams } from './data'

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseSync } from '@babel/core'
// @ts-expect-error missing types
import preset from '@babel/preset-typescript'
import traverse from '@babel/traverse'
import { computed, defineExtension, executeCommand, shallowRef, toValue as track, useActiveTextEditor, useCommand, useDisposable, useDocumentText, useEditorDecorations, watchEffect } from 'reactive-vscode'
import { ConfigurationTarget, languages, MarkdownString, Position, Range, Uri, window, workspace } from 'vscode'
import { config, enabled, hover, namedCatalogsColors, namedCatalogsColorsSalt, namedCatalogsLabel, workspaceFilePath } from './config'
import { catalogPrefix, PACKAGE_MANAGERS_NAME } from './constants'
import { WorkspaceManager } from './data'
import { commands } from './generated/meta'
import { getCatalogColor, getNodeRange, logger } from './utils'

const STANDARD_WORKSPACE_FILES = ['pnpm-workspace.yaml', '.yarnrc.yml', 'bun.lock', 'bun.lockb']

/**
 * Returns true if a relevant workspace file exists at either the root of any
 * VS Code workspace folder (standard detection) or at the custom path
 * provided via the `workspaceFilePath` setting.
 */
function hasRelevantWorkspaceFile(): boolean {
  const folders = workspace.workspaceFolders
  if (!folders || folders.length === 0)
    return false

  const customPath = workspaceFilePath()

  for (const folder of folders) {
    const root = folder.uri.fsPath

    // Custom path takes priority: if it's set, only check that location.
    if (customPath) {
      if (existsSync(join(root, customPath)))
        return true
    }
    else {
      // Standard auto-detection: look for any known workspace file at the root.
      if (STANDARD_WORKSPACE_FILES.some(f => existsSync(join(root, f))))
        return true
    }
  }

  return false
}

const { activate, deactivate } = defineExtension(() => {
  // Guard: do nothing if no relevant workspace file exists at the expected
  // location. This keeps the extension silent in unrelated workspaces when
  // activated via the `onStartupFinished` event.
  if (!hasRelevantWorkspaceFile()) {
    logger.info('No relevant workspace file found; extension is inactive.')
    return
  }

  const manager = new WorkspaceManager()

  const editor = useActiveTextEditor()
  const tick = shallowRef(0)

  useDisposable(workspace.onDidChangeTextDocument(() => {
    tick.value++
  }))
  useDisposable(workspace.onDidOpenTextDocument(() => {
    tick.value++
  }))
  useDisposable(workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('catalogLens.workspaceFilePath')) {
      manager.clearFindUpCache()
      tick.value++
    }
  }))

  const doc = computed(() => {
    track(tick)
    if (!editor.value || !editor.value.document)
      return
    if (!editor.value.document.fileName.match(/[\\/]package\.json$/))
      return
    return editor.value.document
  })

  const text = useDocumentText(() => doc.value)

  // const workspaceData = computed(() => {
  //   if (!doc.value)
  //     return
  //   return readCatalog(doc.value.uri.fsPath)
  // })

  const parsed = computed(() => {
    if (!text.value)
      return

    const prefix = 'const x = '
    const offset = -prefix.length
    const combined = prefix + text.value

    try {
      return {
        offset,
        ast: parseSync(
          combined,
          {
            filename: doc.value?.uri.fsPath,
            presets: [preset],
            babelrc: false,
          },
        ),
      }
    }
    catch (error) {
      logger.error(error)
    }
  })

  const properties = computed(() => {
    if (!parsed.value?.ast)
      return []

    const items: {
      node: ObjectProperty
      catalog: string
    }[] = []

    const { ast } = parsed.value

    traverse(ast, {
      ObjectProperty(path) {
        const key = path.node.key
        const value = path.node.value

        if (key.type !== 'StringLiteral' || value.type !== 'StringLiteral') {
          return
        }

        if (!value.value.startsWith(catalogPrefix))
          return

        items.push({
          node: path.node,
          catalog: value.value.slice(catalogPrefix.length).trim() || 'default',
        })
      },
    })

    return items
  })

  const decorationsOverride = shallowRef<DecorationOptions[]>([])
  const decorationsHover = shallowRef<DecorationOptions[]>([])

  const selections = shallowRef<readonly Selection[]>([])

  useDisposable(window.onDidChangeTextEditorSelection((e) => {
    if (e.textEditor !== editor.value)
      selections.value = []
    else
      selections.value = e.selections
  }))

  watchEffect(async () => {
    if (!enabled() || !editor.value || !doc.value || editor.value?.document !== doc.value) {
      decorationsOverride.value = []
      decorationsHover.value = []
      return
    }

    const offset = parsed.value?.offset || 0
    const props = properties.value
    const _selections = selections.value

    const overrides: DecorationOptions[] = []
    const hovers: DecorationOptions[] = []

    await Promise.all(props.map(async ({ node, catalog }) => {
      catalog = catalog || 'default'
      const { version, definition, manager: packageManager } = await manager.resolveCatalog(
        doc.value!,
        (node.key as StringLiteral).value,
        catalog,
      ) || {}
      if (!version)
        return

      let versionPositionCommandUri
      if (definition) {
        const args = [
          {
            workspacePath: definition.uri.fsPath,
            versionPosition: { line: definition.range.start.line + 1, column: definition.range.start.character },
          } satisfies JumpLocationParams,
        ]
        versionPositionCommandUri = Uri.parse(
          `command:${commands.gotoDefinition}?${encodeURIComponent(JSON.stringify(args))}`,
        )
      }

      const md = new MarkdownString()
      md.appendMarkdown([
        `- ${packageManager ? PACKAGE_MANAGERS_NAME[packageManager] : ''} Catalog: \`${catalog}\``,
        versionPositionCommandUri ? `- Version: [${version}](${versionPositionCommandUri})` : `- Version: \`${version}\``,
      ].join('\n'))
      md.isTrusted = true

      const range = getNodeRange(doc.value!, node, offset)
      let inSelection = false
      for (const selection of _selections) {
        if (selection.contains(range)) {
          inSelection = true
          break
        }
        const lines = [selection.start.line, selection.end.line]
        if (lines.includes(range.start.line) || lines.includes(range.end.line)) {
          inSelection = true
          break
        }
      }

      hovers.push({
        range: new Range(
          doc.value!.positionAt(node.start! + offset),
          doc.value!.positionAt(node.end! + offset),
        ),
        hoverMessage: md,
      })

      const color = namedCatalogsColors()
        ? getCatalogColor(catalog === 'default' ? 'default' : `${catalog}-${namedCatalogsColorsSalt()}`)
        : getCatalogColor('default')

      if (!inSelection) {
        overrides.push({
          range,
          renderOptions: {
            before: {
              contentText: version,
              color,
              backgroundColor: `${color}20; border-radius: 0.2em; padding: 0 0.2em;`,
            },
            after: namedCatalogsLabel() && catalog !== 'default'
              ? {
                  contentText: `${catalog}`,
                  color: `${color}cc; padding-left: 0.4em; font-size: 0.8em;`,
                }
              : undefined,
          },
        })
      }
    }),
    )

    decorationsOverride.value = overrides
    if (hover())
      decorationsHover.value = hovers
  })

  useEditorDecorations(
    editor,
    {
      opacity: '0; display: none;',
    },
    decorationsOverride,
  )

  useEditorDecorations(
    editor,
    {},
    decorationsHover,
  )

  const toggleCommand = () => config.$update('enabled', !config.enabled, ConfigurationTarget.Global)
  const gotoDefinitionCommand = ({ workspacePath, versionPosition }: JumpLocationParams) => {
    executeCommand(
      'editor.action.goToLocations',
      Uri.file(workspacePath),
      new Position(versionPosition.line - 1, versionPosition.column),
      [],
      'goto',
    )
  }

  useCommand(commands.toggle, toggleCommand)
  useCommand(commands.gotoDefinition, gotoDefinitionCommand)

  // Legacy commands for backward compatibility - will be removed in future versions
  useCommand(commands.pnpmCatalogLensToggle, toggleCommand)
  useCommand(commands.pnpmCatalogLensGotoDefinition, gotoDefinitionCommand)

  useDisposable(
    languages.registerDefinitionProvider({ pattern: '**/package.json' }, {
      async provideDefinition(document, position, token) {
        if (doc.value?.fileName !== document.fileName)
          return

        const offset = parsed.value?.offset || 0
        const selected = properties.value.find(prop => getNodeRange(doc.value!, prop.node, offset).contains(position))
        if (!selected)
          return

        const { version, definition } = await manager.resolveCatalog(
          doc.value!,
          (selected.node.key as StringLiteral).value,
          selected.catalog,
        ) || {}
        if (!version || token.isCancellationRequested)
          return

        return definition
      },
    }),
  )
})

export { activate, deactivate }
