// Channel catalog contract tests cover bundled and registry-backed channel catalog invariants.
import fs from "node:fs";
import path from "node:path";
import { isPrereleaseSemverVersion } from "../../../infra/npm-registry-spec.js";
import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "./test-helpers/channel-catalog-contract.js";

describeChannelCatalogEntryContract({
  channelId: "imessage",
  npmSpec: "@openclaw/imessage",
  alias: "imsg",
});

const imessageMeta = {
  id: "imessage",
  label: "iMessage",
  selectionLabel: "iMessage (imsg)",
  detailLabel: "iMessage",
  docsPath: "/channels/imessage",
  blurb: "Local iMessage/SMS through the imsg bridge, including private API message actions when enabled.",
};

const imessagePackageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "extensions", "imessage", "package.json"), "utf8"),
) as {
  name?: string;
  version?: string;
  openclaw?: { install?: { npmSpec?: string } };
};
const imessageNpmSpec = imessagePackageJson.openclaw?.install?.npmSpec ?? imessagePackageJson.name;
const imessageVersion = imessagePackageJson.version;
if (!imessageNpmSpec || !imessageVersion) {
  throw new Error("missing package metadata for imessage");
}
const imessageOfficialFallbackNpmSpec = isPrereleaseSemverVersion(imessageVersion)
  ? `${imessageNpmSpec}@${imessageVersion}`
  : imessageNpmSpec;

describeBundledMetadataOnlyChannelCatalogContract({
  pluginId: "imessage",
  packageName: "@openclaw/imessage",
  npmSpec: "@openclaw/imessage",
  meta: imessageMeta,
  defaultChoice: "npm",
});

describeOfficialFallbackChannelCatalogContract({
  channelId: "imessage",
  npmSpec: imessageOfficialFallbackNpmSpec,
  meta: imessageMeta,
  packageName: "@openclaw/imessage",
  externalNpmSpec: "@vendor/imessage-fork",
  externalLabel: "iMessage Fork",
});

describeChannelCatalogEntryContract({
  channelId: "wecom",
  npmSpec: "@wecom/wecom-openclaw-plugin@2026.7.2",
  alias: "wework",
});

describeChannelCatalogEntryContract({
  channelId: "yuanbao",
  npmSpec: "openclaw-plugin-yuanbao@2.18.2",
  alias: "yb",
});

describeChannelCatalogEntryContract({
  channelId: "openclaw-zaloclawbot",
  npmSpec: "@zalo-platforms/openclaw-zaloclawbot@0.1.4",
  alias: "zaloclawbot",
});
