import { Octokit } from "@octokit/rest";
import { getInput, warning, setFailed } from "@actions/core";
import { context } from "@actions/github";
import dateformat from "dateformat";
import axios from "axios";
interface Deployment {
  schemaVersion?: string;
  deploymentSequenceNumber: string;
  updateSequenceNumber: string;
  issueKeys: string[];
  displayName: string;
  url: string;
  description: string;
  lastUpdated: string;
  label: string;
  state: string;
  pipeline: {
    id: string;
    displayName: string;
    url: string;
  };
  environment: {
    id: string;
    displayName: string;
    type: string;
  };
}

interface DeploymentResponse {
  rejectedDeployments?: {
    errors: {
      message: string;
    }[];
  }[];
}

interface JiraConfig {
  "cloud-instance-base-url": string;
  "client-id": string;
  "client-secret": string;
  "display-name": string;
  description: string;
  label: string;
  "environment-id": string;
  "environment-display-name": string;
  "environment-type": string;
}

const OWNER = context.payload.repository!.owner.login;
const REPO = context.payload.repository!.name;
const BRANCH = "master";
const TAG_NAME = getInput("tag-name");
const JIRA_INFO = (Object.fromEntries(
  [
    "cloud-instance-base-url",
    "client-id",
    "client-secret",
    "display-name",
    "description",
    "label",
    "environment-id",
    "environment-display-name",
    "environment-type"
  ].map(key => [key, getInput(key)])
) as unknown) as JiraConfig;

const token = process.env["GITHUB_TOKEN"];
const octokit = new Octokit({
  auth: token
});

async function getCommitMessagesSinceLatestTag() {
  const result = await octokit.repos.compareCommits({
    owner: OWNER,
    repo: REPO,
    base: TAG_NAME,
    head: BRANCH
  });

  return result.data.commits.map(commit => commit.commit.message);
}

const jiraIssueNrPattern = /([A-Z]+-\d+)/;

function extractJiraIssuesFromTags(messages: string[]): string[] {
  const result: Set<string> = new Set();

  for (const message of messages) {
    const match = jiraIssueNrPattern.exec(message);
    if (!match) {
      continue;
    }

    const [, issue] = match;
    result.add(issue);
  }

  return Array.from(result);
}

async function getJiraAccessToken() {
  const {
    data: { access_token }
  } = await axios.post<{ access_token: string }>(
    "https://api.atlassian.com/oauth/token",
    {
      audience: "api.atlassian.com",
      grant_type: "client_credentials",
      client_id: JIRA_INFO["client-id"],
      client_secret: JIRA_INFO["client-secret"]
    }
  );

  return access_token;
}

async function informJiraProductionDeployment(issueKeys: string[]) {
  const deployment: Deployment = {
    issueKeys,
    schemaVersion: "1.0",
    deploymentSequenceNumber: process.env["GITHUB_RUN_ID"]!,
    updateSequenceNumber: process.env["GITHUB_RUN_ID"]!,
    displayName: JIRA_INFO["display-name"] || "",
    url: `${context.payload.repository!.url}/actions/runs/${process.env[
      "GITHUB_RUN_ID"
    ]!}`,
    description: JIRA_INFO.description || "",
    lastUpdated: dateformat(new Date(), "yyyy-mm-dd'T'HH:MM:ss'Z'") || "",
    label: JIRA_INFO.label || "",
    state: "successful",
    pipeline: {
      id: `${context.payload.repository!.full_name} ${context.workflow}`,
      displayName: `Workflow: ${context.workflow} (#${process.env["GITHUB_RUN_NUMBER"]})`,
      url: `${context.payload.repository!.url}/actions/runs/${process.env[
        "GITHUB_RUN_ID"
      ]!}`
    },
    environment: {
      id: JIRA_INFO["environment-id"] || "",
      displayName: JIRA_INFO["display-name"] || "",
      type: JIRA_INFO["environment-type"] || ""
    }
  };

  const {
    data: { cloudId }
  } = await axios.get<{ cloudId: string }>(
    `${JIRA_INFO["cloud-instance-base-url"]}/_edge/tenant_info`
  );

  const {
    data: { rejectedDeployments }
  } = await axios.post<DeploymentResponse>(
    `https://api.atlassian.com/jira/deployments/0.1/cloud/${cloudId}/bulk"`,
    deployment,
    {
      headers: {
        Authorization: `Bearer ${await getJiraAccessToken()}`
      }
    }
  );

  if (rejectedDeployments && rejectedDeployments.length > 0) {
    const [rejectedDeployment] = rejectedDeployments;
    const message = rejectedDeployment.errors
      .map(error => error.message)
      .join(",");

    throw new Error(message);
  }
}

async function createTagForHead() {
  const {
    data: { sha }
  } = await octokit.repos.getCommit({
    ref: BRANCH,
    owner: "everweij",
    repo: "react-laag"
  });

  return octokit.git.createTag({
    owner: OWNER,
    repo: REPO,
    tag: TAG_NAME,
    message: "Deployment to production",
    object: sha,
    type: "commit"
  });
}

async function run() {
  let messages: string[];

  try {
    messages = await getCommitMessagesSinceLatestTag();
  } catch (err) {
    setFailed(
      `An error occured while retreiving commit messages: ${String(err)}`
    );
    return;
  }

  const keys = extractJiraIssuesFromTags(messages);

  if (!keys.length) {
    warning("There are no issue keys found. Aborting...");
    return;
  }

  try {
    await informJiraProductionDeployment(keys);
  } catch (err) {
    setFailed(
      `An error occured while sending deployment info to Jira: ${String(err)}`
    );
    return;
  }

  try {
    await createTagForHead();
  } catch (err) {
    setFailed(`An error occured while tagging latest commit: ${String(err)}`);
    return;
  }

  console.log(
    "Successfully informed Jira about production deployment for issue-keys: "
  );
  console.log(keys.join("\n"));
}

run();
