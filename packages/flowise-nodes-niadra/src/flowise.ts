/**
 * The parts of Flowise's node interface these nodes implement, as types only. Reproduced from
 * Flowise, packages/components/src/Interface.ts, Copyright (c) 2023-present FlowiseAI, Inc.,
 * Apache License 2.0 (see NOTICE). Only the members used here are kept.
 */

import type { BaseMessage } from "@langchain/core/messages";

export type ICommonObject = Record<string, any>;

export type MessageType = "apiMessage" | "userMessage";

export interface INodeOptionsValue {
  label: string;
  name: string;
  description?: string;
}

export interface INodeParams {
  label: string;
  name: string;
  type: string;
  default?: unknown;
  description?: string;
  options?: INodeOptionsValue[];
  optional?: boolean;
  acceptVariable?: boolean;
  additionalParams?: boolean;
  placeholder?: string;
  credentialNames?: string[];
  list?: boolean;
}

export interface INodeProperties {
  label: string;
  name: string;
  type: string;
  icon: string;
  version: number;
  category: string;
  baseClasses: string[];
  description?: string;
  documentation?: string;
}

export interface INode extends INodeProperties {
  credential?: INodeParams;
  inputs?: INodeParams[];
  init?(nodeData: INodeData, input: string, options?: ICommonObject): Promise<any>;
}

export interface INodeData extends INodeProperties {
  id: string;
  inputs?: ICommonObject;
  credential?: string;
}

export interface IMessage {
  message: string;
  type: MessageType;
}

export interface MemoryMethods {
  getChatMessages(overrideSessionId?: string, returnBaseMessages?: boolean, prependMessages?: IMessage[]): Promise<IMessage[] | BaseMessage[]>;
  addChatMessages(msgArray: { text: string; type: MessageType }[], overrideSessionId?: string): Promise<void>;
  clearChatMessages(overrideSessionId?: string): Promise<void>;
}
