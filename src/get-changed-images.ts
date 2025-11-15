import path from 'path'
import { minimatch } from 'minimatch'
import { Octokit } from '@octokit/action'
import { context } from '@actions/github'
import * as core from '@actions/core'
import * as exec from '@actions/exec'

import { FILE_EXTENSIONS_TO_PROCESS, REPO_DIRECTORY } from './constants.ts'
import getConfig from './config.ts'

const getChangedImages = async (): Promise<string[] | null> => {
  try {
    if (!context.payload.pull_request) {
      core.info('No pull request context found.')
      return null
    }

    const config = await getConfig()
    const api = new Octokit()
    const owner = context.repo.owner
    const repo = context.repo.repo
    const pullNumber = context.payload.pull_request.number

    core.info(`Fetching changed files for PR #${pullNumber}…`)

    // first get the PR's own changed files
    const { data: files } = await api.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber
    })

    const validStatus = new Set(["added", "modified", "changed"])

    const isValidExt = (filename: string) => {
      const ext = path.extname(filename).toLowerCase().slice(1)
      return FILE_EXTENSIONS_TO_PROCESS.includes(ext)
    }

    const shouldIgnore = (filename: string) => {
      return config.ignorePaths.some(ignorePath => {
        return minimatch(filename, ignorePath)
      })
    }

    let changedImages = files
      .filter(file => {
        return (
          isValidExt(file.filename) && validStatus.has(file.status)
        )
      })
      .map(file => file.filename)
      .filter(filename => {
        return !shouldIgnore(filename)
      })
    
    // assume as safe environment for git
    await exec.exec("git", ["config", "--global", "--add", "safe.directory", REPO_DIRECTORY])

    // now get the diff 
    const commit = context.sha
    let gitDiff = ""
    const gitDiffOptions = {
      listeners: {
        stdout: (data) => {
          gitDiff += data.toString()
        }
      },
      cwd: REPO_DIRECTORY
    }
    const gitDiffExitCode = await exec.exec("git", ["diff", "--name-status", commit], gitDiffOptions)

    if (gitDiffExitCode === 0) {
      const changedImageSet = new Set(changedImages)
      const addingGitStatus = new Set(["A", "M", "T"])
      const changes = gitDiff.split("\n")
      for (const file of changes) {
        if (file.length === 0) {
          continue
        }
        const data = file.trim().split(/\s+/)
        const status = data[0]
        const filename = data[1]
        const renamed = data.length > 2 ? data[2] : null
        if (isValidExt(filename)) {
          if (status === "D") {
            // if deleted
            changedImageSet.delete(filename)
          } else if (status.startsWith("R")) {
            // if renamed
            changedImageSet.delete(filename)
            if (renamed && !shouldIgnore(renamed)) {
              changedImageSet.add(renamed)
            }
          } else if (addingGitStatus.has(status)) {
            changedImageSet.add(filename)
          }
        }
      }

      changedImages = Array.from(changedImageSet)
    }

    // now get the untracked files
    let gitUntracked = ""
    const gitUntrackedOptions = {
      listeners: {
        stdout: (data) => {
          gitUntracked += data.toString()
        }
      },
      cwd: REPO_DIRECTORY
    }
    const gitUntrackedExitCode = await exec.exec("git", ["ls-files", "--others", "--exclude-standard"], gitUntrackedOptions)

    if (gitUntrackedExitCode === 0) {
      const files = gitUntracked.split("\n")
      for (const file of files) {
        if (file.length === 0) {
          continue
        }
        let filename = file.trim()
        if (isValidExt(filename) && !shouldIgnore(filename)) {
          changedImages.push(filename)
        }
      }
    }

    core.info(
      `Found ${changedImages.length} images to process${changedImages.length > 0 ? `: ${changedImages.join(', ')}` : ""}.`
    )

    return changedImages
  } catch (error) {
    const isError = error instanceof Error;
    core.warning(
      `Error getting changed images: ${isError ? error.message : String(error)}`
    )
    if (isError && error.stack) {
      core.warning(error.stack)
    }
    return null
  }
}

export default getChangedImages
