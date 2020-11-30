const lightstepContext = require('./context/lightstep')
const rollbarContext = require('./context/rollbar')
const pagerdutyContext = require('./context/pagerduty')
const github = require('@actions/github')

const { assertActionInput, resolveActionInput } = require('./utils')

const core = require('@actions/core')
const path = require('path')
const fs = require('fs')
const template = require('lodash.template')


const tmplFile = fs.readFileSync(path.resolve('./pr.tmpl.md'), 'utf8')
const prTemplate = template(tmplFile)

/*
   * Determines status of all pre-deploy checks
   * @param  {...any} states array of context summary statuses
   */
const actionState = (...states) => {
    return (states.find(s => s === 'error') ||
        states.find(s => s === 'warn') ||
        states.find(s => s === 'unknown') ||
        'ok')
}

function conditionStatus(s) {
    switch (s.state) {
    case "true":
        return ":red_circle:"
    case "false":
        return ":green_circle:"
    default:
        return ":white_circle:"
    }
}

function trafficLightStatus(s) {
    switch (s) {
    case "unknown":
        return ":white_circle:"
    case "error":
        return ":red_circle:"
    case "ok":
        return ":green_circle:"
    }
}

module.exports.predeploy = async function({ lightstepOrg, lightstepProj, lightstepToken, yamlFile, isRollup }) {
    // Lightstep context
    var templateContext = { trafficLightStatus, conditionStatus }
    templateContext.lightstep = await lightstepContext.getSummary(
        { lightstepOrg, lightstepProj, lightstepToken, lightstepConditions : yamlFile.conditions })

    // Rollbar context
    if (yamlFile.integrations && yamlFile.integrations.rollbar) {
        assertActionInput('rollbar_api_token')
        const token = resolveActionInput('rollbar_api_token')
        templateContext.rollbar = await rollbarContext.getSummary(
            { token : token, yamlConfig : yamlFile.integrations.rollbar })
    } else {
        templateContext.rollbar = false
    }

    // PagerDuty context
    if (yamlFile.integrations && yamlFile.integrations.pagerduty) {
        assertActionInput('pagerduty_api_token')
        const token = resolveActionInput('pagerduty_api_token')
        templateContext.pagerduty = await pagerdutyContext.getSummary(
            { token : token, yamlConfig : yamlFile.integrations.pagerduty })
    } else {
        templateContext.pagerduty = false
    }

    templateContext.isRollup = isRollup
    templateContext.status = actionState(
        templateContext.lightstep.status,
        templateContext.rollbar && templateContext.rollbar.status)

    const markdown = prTemplate(templateContext)
    core.setOutput('lightstep_predeploy_status', templateContext.status)
    core.setOutput('lightstep_predeploy_md', markdown)

    // add pull request or issue comment
    const disableComment = resolveActionInput('disable_comment')
    const token = resolveActionInput('github_token')
    if (disableComment !== 'true' && token && token.length > 0) {
        var octokit
        try {
            octokit = github.getOctokit(token)
        } catch (e) {
            core.setFailed(`could not initialize github api client: ${e}`)
            return
        }

        const context = github.context
        if (context.issue && context.issue.number) {
            await octokit.issues.createComment({
                issue_number : context.issue.number,
                owner        : context.repo.owner,
                repo         : context.repo.repo,
                body         : markdown,
            })
        } else if (context.sha) {
            core.info(`attempting to find pr: ${context.repo.owner}/${context.repo.repo}@${context.sha}...`)
            const pulls = await octokit.repos.listPullRequestsAssociatedWithCommit({
                owner      : context.repo.owner,
                repo       : context.repo.repo,
                commit_sha : context.sha,
            })
            if (pulls.data.length === 0) {
                core.info('could not find a pull request associated with the git sha')
                return
            }
            const num = pulls.data[0].number
            core.info(`commenting on pr #{num}...`)
            await octokit.issues.createComment({
                issue_number : num,
                owner        : context.repo.owner,
                repo         : context.repo.repo,
                body         : markdown
            })
        } else {
            core.info('could not find a SHA or issue number')
        }
    }

    return Promise.resolve()
}
