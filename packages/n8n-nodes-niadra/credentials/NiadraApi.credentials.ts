// The credential's layout (authenticate and test blocks) follows Mem0's n8n node, MIT License,
// Copyright (c) 2023-2026 Taranjeet Singh; see NOTICE.
import type { IAuthenticateGeneric, Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from "n8n-workflow";

/**
 * The address of a space, read from its key (`nia_sk_<live|test>_<region>_<space>_<key_id>_<secret>`)
 * unless a base URL is given, as the SDKs do.
 */
export const BASE_URL_EXPRESSION =
  '={{ $credentials.baseUrl ? $credentials.baseUrl : "https://" + $credentials.apiKey.split("_")[4] + "." + $credentials.apiKey.split("_")[3] + ".api.niadra.com" }}';

export class NiadraApi implements ICredentialType {
  name = "niadraApi";

  displayName = "Niadra API";

  icon: Icon = { light: "file:niadra.svg", dark: "file:niadra.svg" };

  documentationUrl = "https://docs.niadra.com/en";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "A source key of your space, starting with nia_sk_. It names the region and the space, so the address comes from it.",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "",
      description: "Leave empty to use the address the key names. Set it only for a local emulator.",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.apiKey}}",
      },
    },
  };

  // An authenticated read that changes nothing: the tool definitions of the space.
  test: ICredentialTestRequest = {
    request: {
      baseURL: BASE_URL_EXPRESSION,
      url: "/v1/history/tools",
      method: "GET",
    },
  };
}
