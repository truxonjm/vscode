/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Event, Emitter } from 'vs/base/common/event';
import * as resources from 'vs/base/common/resources';
import { generateUuid } from 'vs/base/common/uuid';
import uri from 'vs/base/common/uri';
import { first, distinct } from 'vs/base/common/arrays';
import { isObject, isUndefinedOrNull } from 'vs/base/common/types';
import * as errors from 'vs/base/common/errors';
import severity from 'vs/base/common/severity';
import { TPromise } from 'vs/base/common/winjs.base';
import * as aria from 'vs/base/browser/ui/aria/aria';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IMarkerService } from 'vs/platform/markers/common/markers';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { FileChangesEvent, FileChangeType, IFileService } from 'vs/platform/files/common/files';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { RawDebugSession } from 'vs/workbench/parts/debug/electron-browser/rawDebugSession';
import { Model, ExceptionBreakpoint, FunctionBreakpoint, Breakpoint, Expression, RawObjectReplElement } from 'vs/workbench/parts/debug/common/debugModel';
import { ViewModel } from 'vs/workbench/parts/debug/common/debugViewModel';
import * as debugactions from 'vs/workbench/parts/debug/browser/debugActions';
import { ConfigurationManager } from 'vs/workbench/parts/debug/electron-browser/debugConfigurationManager';
import Constants from 'vs/workbench/parts/markers/electron-browser/constants';
import { ITaskService, ITaskSummary } from 'vs/workbench/parts/tasks/common/taskService';
import { TaskError } from 'vs/workbench/parts/tasks/common/taskSystem';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from 'vs/workbench/parts/files/common/files';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IPartService, Parts } from 'vs/workbench/services/part/common/partService';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkspaceContextService, WorkbenchState, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { EXTENSION_LOG_BROADCAST_CHANNEL, EXTENSION_ATTACH_BROADCAST_CHANNEL, EXTENSION_TERMINATE_BROADCAST_CHANNEL, EXTENSION_RELOAD_BROADCAST_CHANNEL, EXTENSION_CLOSE_EXTHOST_BROADCAST_CHANNEL } from 'vs/platform/extensions/common/extensionHost';
import { IBroadcastService, IBroadcast } from 'vs/platform/broadcast/electron-browser/broadcastService';
import { IRemoteConsoleLog, parse, getFirstFrame } from 'vs/base/node/console';
import { Source } from 'vs/workbench/parts/debug/common/debugSource';
import { TaskEvent, TaskEventKind, TaskIdentifier } from 'vs/workbench/parts/tasks/common/tasks';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IAction, Action } from 'vs/base/common/actions';
import { normalizeDriveLetter } from 'vs/base/common/labels';
import { deepClone, equals } from 'vs/base/common/objects';
import { Session } from 'vs/workbench/parts/debug/electron-browser/debugSession';
import { equalsIgnoreCase } from 'vs/base/common/strings';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { IDebugService, State, ISession, CONTEXT_DEBUG_TYPE, CONTEXT_DEBUG_STATE, CONTEXT_IN_DEBUG_MODE, IThread, IDebugConfiguration, VIEWLET_ID, REPL_ID, IConfig, ILaunch, IViewModel, IConfigurationManager, IModel, IReplElementSource, IEnablement, IBreakpoint, IBreakpointData, IExpression, ICompound, IGlobalConfig, IStackFrame } from 'vs/workbench/parts/debug/common/debug';

const DEBUG_BREAKPOINTS_KEY = 'debug.breakpoint';
const DEBUG_BREAKPOINTS_ACTIVATED_KEY = 'debug.breakpointactivated';
const DEBUG_FUNCTION_BREAKPOINTS_KEY = 'debug.functionbreakpoint';
const DEBUG_EXCEPTION_BREAKPOINTS_KEY = 'debug.exceptionbreakpoint';
const DEBUG_WATCH_EXPRESSIONS_KEY = 'debug.watchexpressions';

export class DebugService implements IDebugService {
	_serviceBrand: any;

	private readonly _onDidChangeState: Emitter<State>;
	private readonly _onDidNewSession: Emitter<ISession>;
	private readonly _onDidEndSession: Emitter<ISession>;
	private model: Model;
	private viewModel: ViewModel;
	private configurationManager: ConfigurationManager;
	private allSessions = new Map<string, ISession>();
	private toDispose: IDisposable[];
	private debugType: IContextKey<string>;
	private debugState: IContextKey<string>;
	private inDebugMode: IContextKey<boolean>;
	private breakpointsToSendOnResourceSaved: Set<string>;
	private firstSessionStart: boolean;
	private skipRunningTask: boolean;
	private previousState: State;

	constructor(
		@IStorageService private storageService: IStorageService,
		@IEditorService private editorService: IEditorService,
		@ITextFileService private textFileService: ITextFileService,
		@IViewletService private viewletService: IViewletService,
		@IPanelService private panelService: IPanelService,
		@INotificationService private notificationService: INotificationService,
		@IDialogService private dialogService: IDialogService,
		@IPartService private partService: IPartService,
		@IWindowService private windowService: IWindowService,
		@IBroadcastService private broadcastService: IBroadcastService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IExtensionService private extensionService: IExtensionService,
		@IMarkerService private markerService: IMarkerService,
		@ITaskService private taskService: ITaskService,
		@IFileService private fileService: IFileService,
		@IConfigurationService private configurationService: IConfigurationService,
	) {
		this.toDispose = [];
		this.breakpointsToSendOnResourceSaved = new Set<string>();
		this._onDidChangeState = new Emitter<State>();
		this._onDidNewSession = new Emitter<ISession>();
		this._onDidEndSession = new Emitter<ISession>();

		this.configurationManager = this.instantiationService.createInstance(ConfigurationManager);
		this.toDispose.push(this.configurationManager);
		this.debugType = CONTEXT_DEBUG_TYPE.bindTo(contextKeyService);
		this.debugState = CONTEXT_DEBUG_STATE.bindTo(contextKeyService);
		this.inDebugMode = CONTEXT_IN_DEBUG_MODE.bindTo(contextKeyService);

		this.model = new Model(this.loadBreakpoints(), this.storageService.getBoolean(DEBUG_BREAKPOINTS_ACTIVATED_KEY, StorageScope.WORKSPACE, true), this.loadFunctionBreakpoints(),
			this.loadExceptionBreakpoints(), this.loadWatchExpressions());
		this.toDispose.push(this.model);
		this.viewModel = new ViewModel(contextKeyService);
		this.firstSessionStart = true;

		this.registerListeners();
	}

	private registerListeners(): void {
		this.toDispose.push(this.fileService.onFileChanges(e => this.onFileChanges(e)));
		this.lifecycleService.onShutdown(this.store, this);
		this.lifecycleService.onShutdown(this.dispose, this);
		this.toDispose.push(this.broadcastService.onBroadcast(this.onBroadcast, this));
		this.toDispose.push(this.viewModel.onDidFocusSession(s => {
			const id = s ? s.getId() : undefined;
			this.model.setBreakpointsSessionId(id);
			this.onStateChange();
		}));
	}

	private onBroadcast(broadcast: IBroadcast): void {
		// attach: PH is ready to be attached to
		const session = <Session>this.allSessions.get(broadcast.payload.debugId);
		if (!session) {
			// Ignore attach events for sessions that never existed (wrong vscode windows)
			return;
		}

		if (broadcast.channel === EXTENSION_ATTACH_BROADCAST_CHANNEL) {
			session.configuration.request = 'attach';
			session.configuration.port = broadcast.payload.port;
			const dbgr = this.configurationManager.getDebugger(session.configuration.type);
			session.initialize(dbgr).then(() => (<RawDebugSession>session.raw).attach(session.configuration));

			return;
		}

		if (broadcast.channel === EXTENSION_TERMINATE_BROADCAST_CHANNEL) {
			session.raw.terminate().done(undefined, errors.onUnexpectedError);
			return;
		}

		// an extension logged output, show it inside the REPL
		if (broadcast.channel === EXTENSION_LOG_BROADCAST_CHANNEL) {
			let extensionOutput: IRemoteConsoleLog = broadcast.payload.logEntry;
			let sev = extensionOutput.severity === 'warn' ? severity.Warning : extensionOutput.severity === 'error' ? severity.Error : severity.Info;

			const { args, stack } = parse(extensionOutput);
			let source: IReplElementSource;
			if (stack) {
				const frame = getFirstFrame(stack);
				if (frame) {
					source = {
						column: frame.column,
						lineNumber: frame.line,
						source: session.getSource({
							name: resources.basenameOrAuthority(frame.uri),
							path: frame.uri.fsPath
						})
					};
				}
			}

			// add output for each argument logged
			let simpleVals: any[] = [];
			for (let i = 0; i < args.length; i++) {
				let a = args[i];

				// undefined gets printed as 'undefined'
				if (typeof a === 'undefined') {
					simpleVals.push('undefined');
				}

				// null gets printed as 'null'
				else if (a === null) {
					simpleVals.push('null');
				}

				// objects & arrays are special because we want to inspect them in the REPL
				else if (isObject(a) || Array.isArray(a)) {

					// flush any existing simple values logged
					if (simpleVals.length) {
						this.logToRepl(simpleVals.join(' '), sev, source);
						simpleVals = [];
					}

					// show object
					this.logToRepl(new RawObjectReplElement((<any>a).prototype, a, undefined, nls.localize('snapshotObj', "Only primitive values are shown for this object.")), sev, source);
				}

				// string: watch out for % replacement directive
				// string substitution and formatting @ https://developer.chrome.com/devtools/docs/console
				else if (typeof a === 'string') {
					let buf = '';

					for (let j = 0, len = a.length; j < len; j++) {
						if (a[j] === '%' && (a[j + 1] === 's' || a[j + 1] === 'i' || a[j + 1] === 'd')) {
							i++; // read over substitution
							buf += !isUndefinedOrNull(args[i]) ? args[i] : ''; // replace
							j++; // read over directive
						} else {
							buf += a[j];
						}
					}

					simpleVals.push(buf);
				}

				// number or boolean is joined together
				else {
					simpleVals.push(a);
				}
			}

			// flush simple values
			// always append a new line for output coming from an extension such that separate logs go to separate lines #23695
			if (simpleVals.length) {
				this.logToRepl(simpleVals.join(' ') + '\n', sev, source);
			}
		}
	}

	tryToAutoFocusStackFrame(thread: IThread): TPromise<any> {
		const callStack = thread.getCallStack();
		if (!callStack.length || (this.viewModel.focusedStackFrame && this.viewModel.focusedStackFrame.thread.getId() === thread.getId())) {
			return TPromise.as(null);
		}

		// focus first stack frame from top that has source location if no other stack frame is focused
		const stackFrameToFocus = first(callStack, sf => sf.source && sf.source.available, undefined);
		if (!stackFrameToFocus) {
			return TPromise.as(null);
		}

		this.focusStackFrame(stackFrameToFocus);
		if (thread.stoppedDetails) {
			if (this.configurationService.getValue<IDebugConfiguration>('debug').openDebug === 'openOnDebugBreak') {
				this.viewletService.openViewlet(VIEWLET_ID).done(undefined, errors.onUnexpectedError);
			}
			this.windowService.focusWindow();
			aria.alert(nls.localize('debuggingPaused', "Debugging paused, reason {0}, {1} {2}", thread.stoppedDetails.reason, stackFrameToFocus.source ? stackFrameToFocus.source.name : '', stackFrameToFocus.range.startLineNumber));
		}

		return stackFrameToFocus.openInEditor(this.editorService, true);
	}

	private loadBreakpoints(): Breakpoint[] {
		let result: Breakpoint[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_BREAKPOINTS_KEY, StorageScope.WORKSPACE, '[]')).map((breakpoint: any) => {
				return new Breakpoint(uri.parse(breakpoint.uri.external || breakpoint.source.uri.external), breakpoint.lineNumber, breakpoint.column, breakpoint.enabled, breakpoint.condition, breakpoint.hitCondition, breakpoint.logMessage, breakpoint.adapterData);
			});
		} catch (e) { }

		return result || [];
	}

	private loadFunctionBreakpoints(): FunctionBreakpoint[] {
		let result: FunctionBreakpoint[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_FUNCTION_BREAKPOINTS_KEY, StorageScope.WORKSPACE, '[]')).map((fb: any) => {
				return new FunctionBreakpoint(fb.name, fb.enabled, fb.hitCondition, fb.condition, fb.logMessage);
			});
		} catch (e) { }

		return result || [];
	}

	private loadExceptionBreakpoints(): ExceptionBreakpoint[] {
		let result: ExceptionBreakpoint[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_EXCEPTION_BREAKPOINTS_KEY, StorageScope.WORKSPACE, '[]')).map((exBreakpoint: any) => {
				return new ExceptionBreakpoint(exBreakpoint.filter, exBreakpoint.label, exBreakpoint.enabled);
			});
		} catch (e) { }

		return result || [];
	}

	private loadWatchExpressions(): Expression[] {
		let result: Expression[];
		try {
			result = JSON.parse(this.storageService.get(DEBUG_WATCH_EXPRESSIONS_KEY, StorageScope.WORKSPACE, '[]')).map((watchStoredData: { name: string, id: string }) => {
				return new Expression(watchStoredData.name, watchStoredData.id);
			});
		} catch (e) { }

		return result || [];
	}

	get state(): State {
		const focusedSession = this.viewModel.focusedSession;
		if (focusedSession) {
			return focusedSession.state;
		}

		return State.Inactive;
	}

	get onDidChangeState(): Event<State> {
		return this._onDidChangeState.event;
	}

	get onDidNewSession(): Event<ISession> {
		return this._onDidNewSession.event;
	}

	get onDidEndSession(): Event<ISession> {
		return this._onDidEndSession.event;
	}

	focusStackFrame(stackFrame: IStackFrame, thread?: IThread, session?: ISession, explicit?: boolean): void {
		if (!session) {
			if (stackFrame || thread) {
				session = stackFrame ? stackFrame.thread.session : thread.session;
			} else {
				const sessions = this.model.getSessions();
				session = sessions.length ? sessions[0] : undefined;
			}
		}

		if (!thread) {
			if (stackFrame) {
				thread = stackFrame.thread;
			} else {
				const threads = session ? session.getAllThreads() : undefined;
				thread = threads && threads.length ? threads[0] : undefined;
			}
		}

		if (!stackFrame) {
			if (thread) {
				const callStack = thread.getCallStack();
				stackFrame = callStack && callStack.length ? callStack[0] : null;
			}
		}

		this.viewModel.setFocus(stackFrame, thread, session, explicit);
	}

	enableOrDisableBreakpoints(enable: boolean, breakpoint?: IEnablement): TPromise<void> {
		if (breakpoint) {
			this.model.setEnablement(breakpoint, enable);
			if (breakpoint instanceof Breakpoint) {
				return this.sendBreakpoints(breakpoint.uri);
			} else if (breakpoint instanceof FunctionBreakpoint) {
				return this.sendFunctionBreakpoints();
			}

			return this.sendExceptionBreakpoints();
		}

		this.model.enableOrDisableAllBreakpoints(enable);
		return this.sendAllBreakpoints();
	}

	addBreakpoints(uri: uri, rawBreakpoints: IBreakpointData[]): TPromise<IBreakpoint[]> {
		const breakpoints = this.model.addBreakpoints(uri, rawBreakpoints);
		breakpoints.forEach(bp => aria.status(nls.localize('breakpointAdded', "Added breakpoint, line {0}, file {1}", bp.lineNumber, uri.fsPath)));

		return this.sendBreakpoints(uri).then(() => breakpoints);
	}

	updateBreakpoints(uri: uri, data: { [id: string]: DebugProtocol.Breakpoint }, sendOnResourceSaved: boolean): void {
		this.model.updateBreakpoints(data);
		if (sendOnResourceSaved) {
			this.breakpointsToSendOnResourceSaved.add(uri.toString());
		} else {
			this.sendBreakpoints(uri);
		}
	}

	removeBreakpoints(id?: string): TPromise<any> {
		const toRemove = this.model.getBreakpoints().filter(bp => !id || bp.getId() === id);
		toRemove.forEach(bp => aria.status(nls.localize('breakpointRemoved', "Removed breakpoint, line {0}, file {1}", bp.lineNumber, bp.uri.fsPath)));
		const urisToClear = distinct(toRemove, bp => bp.uri.toString()).map(bp => bp.uri);

		this.model.removeBreakpoints(toRemove);

		return TPromise.join(urisToClear.map(uri => this.sendBreakpoints(uri)));
	}

	setBreakpointsActivated(activated: boolean): TPromise<void> {
		this.model.setBreakpointsActivated(activated);
		return this.sendAllBreakpoints();
	}

	addFunctionBreakpoint(name?: string, id?: string): void {
		const newFunctionBreakpoint = this.model.addFunctionBreakpoint(name || '', id);
		this.viewModel.setSelectedFunctionBreakpoint(newFunctionBreakpoint);
	}

	renameFunctionBreakpoint(id: string, newFunctionName: string): TPromise<void> {
		this.model.renameFunctionBreakpoint(id, newFunctionName);
		return this.sendFunctionBreakpoints();
	}

	removeFunctionBreakpoints(id?: string): TPromise<void> {
		this.model.removeFunctionBreakpoints(id);
		return this.sendFunctionBreakpoints();
	}

	addReplExpression(name: string): TPromise<void> {
		return this.model.addReplExpression(this.viewModel.focusedSession, this.viewModel.focusedStackFrame, name)
			// Evaluate all watch expressions and fetch variables again since repl evaluation might have changed some.
			.then(() => this.focusStackFrame(this.viewModel.focusedStackFrame, this.viewModel.focusedThread, this.viewModel.focusedSession));
	}

	removeReplExpressions(): void {
		this.model.removeReplExpressions();
	}

	logToRepl(value: string | IExpression, sev = severity.Info, source?: IReplElementSource): void {
		const clearAnsiSequence = '\u001b[2J';
		if (typeof value === 'string' && value.indexOf(clearAnsiSequence) >= 0) {
			// [2J is the ansi escape sequence for clearing the display http://ascii-table.com/ansi-escape-sequences.php
			this.model.removeReplExpressions();
			this.model.appendToRepl(nls.localize('consoleCleared', "Console was cleared"), severity.Ignore);
			value = value.substr(value.indexOf(clearAnsiSequence) + clearAnsiSequence.length);
		}

		this.model.appendToRepl(value, sev, source);
	}

	addWatchExpression(name: string): void {
		const we = this.model.addWatchExpression(name);
		this.viewModel.setSelectedExpression(we);
	}

	renameWatchExpression(id: string, newName: string): void {
		return this.model.renameWatchExpression(id, newName);
	}

	moveWatchExpression(id: string, position: number): void {
		this.model.moveWatchExpression(id, position);
	}

	removeWatchExpressions(id?: string): void {
		this.model.removeWatchExpressions(id);
	}

	startDebugging(launch: ILaunch, configOrName?: IConfig | string, noDebug = false, unresolvedConfiguration?: IConfig, ): TPromise<void> {
		const sessionId = generateUuid();

		// make sure to save all files and that the configuration is up to date
		return this.extensionService.activateByEvent('onDebug').then(() => this.textFileService.saveAll().then(() => this.configurationService.reloadConfiguration(launch ? launch.workspace : undefined).then(() =>
			this.extensionService.whenInstalledExtensionsRegistered().then(() => {
				if (this.model.getSessions().length === 0) {
					this.removeReplExpressions();
					this.allSessions.clear();
				}

				let config: IConfig, compound: ICompound;
				if (!configOrName) {
					configOrName = this.configurationManager.selectedConfiguration.name;
				}
				if (typeof configOrName === 'string' && launch) {
					config = launch.getConfiguration(configOrName);
					compound = launch.getCompound(configOrName);

					const sessions = this.model.getSessions();
					const alreadyRunningMessage = nls.localize('configurationAlreadyRunning', "There is already a debug configuration \"{0}\" running.", configOrName);
					if (sessions.some(s => s.getName(false) === configOrName && (!launch || !launch.workspace || !s.root || s.root.uri.toString() === launch.workspace.uri.toString()))) {
						return TPromise.wrapError(new Error(alreadyRunningMessage));
					}
					if (compound && compound.configurations && sessions.some(p => compound.configurations.indexOf(p.getName(false)) !== -1)) {
						return TPromise.wrapError(new Error(alreadyRunningMessage));
					}
				} else if (typeof configOrName !== 'string') {
					config = configOrName;
				}

				if (compound) {
					if (!compound.configurations) {
						return TPromise.wrapError(new Error(nls.localize({ key: 'compoundMustHaveConfigurations', comment: ['compound indicates a "compounds" configuration item', '"configurations" is an attribute and should not be localized'] },
							"Compound must have \"configurations\" attribute set in order to start multiple configurations.")));
					}

					return TPromise.join(compound.configurations.map(configData => {
						const name = typeof configData === 'string' ? configData : configData.name;
						if (name === compound.name) {
							return TPromise.as(null);
						}

						let launchForName: ILaunch;
						if (typeof configData === 'string') {
							const launchesContainingName = this.configurationManager.getLaunches().filter(l => !!l.getConfiguration(name));
							if (launchesContainingName.length === 1) {
								launchForName = launchesContainingName[0];
							} else if (launchesContainingName.length > 1 && launchesContainingName.indexOf(launch) >= 0) {
								// If there are multiple launches containing the configuration give priority to the configuration in the current launch
								launchForName = launch;
							} else {
								return TPromise.wrapError(new Error(launchesContainingName.length === 0 ? nls.localize('noConfigurationNameInWorkspace', "Could not find launch configuration '{0}' in the workspace.", name)
									: nls.localize('multipleConfigurationNamesInWorkspace', "There are multiple launch configurations '{0}' in the workspace. Use folder name to qualify the configuration.", name)));
							}
						} else if (configData.folder) {
							const launchesMatchingConfigData = this.configurationManager.getLaunches().filter(l => l.workspace && l.workspace.name === configData.folder && !!l.getConfiguration(configData.name));
							if (launchesMatchingConfigData.length === 1) {
								launchForName = launchesMatchingConfigData[0];
							} else {
								return TPromise.wrapError(new Error(nls.localize('noFolderWithName', "Can not find folder with name '{0}' for configuration '{1}' in compound '{2}'.", configData.folder, configData.name, compound.name)));
							}
						}

						return this.startDebugging(launchForName, name, noDebug, unresolvedConfiguration);
					}));
				}
				if (configOrName && !config) {
					const message = !!launch ? nls.localize('configMissing', "Configuration '{0}' is missing in 'launch.json'.", configOrName) :
						nls.localize('launchJsonDoesNotExist', "'launch.json' does not exist.");
					return TPromise.wrapError(new Error(message));
				}

				// We keep the debug type in a separate variable 'type' so that a no-folder config has no attributes.
				// Storing the type in the config would break extensions that assume that the no-folder case is indicated by an empty config.
				let type: string;
				if (config) {
					type = config.type;
				} else {
					// a no-folder workspace has no launch.config
					config = <IConfig>{};
				}
				unresolvedConfiguration = unresolvedConfiguration || deepClone(config);

				if (noDebug) {
					config.noDebug = true;
				}

				return (type ? TPromise.as(null) : this.configurationManager.guessDebugger().then(a => type = a && a.type)).then(() =>
					this.configurationManager.resolveConfigurationByProviders(launch && launch.workspace ? launch.workspace.uri : undefined, type, config).then(config => {
						// a falsy config indicates an aborted launch
						if (config && config.type) {
							return this.createSession(launch, config, unresolvedConfiguration, sessionId);
						}

						if (launch && type) {
							return launch.openConfigFile(false, type).done(undefined, errors.onUnexpectedError);
						}
					})
				).then(() => undefined);
			})
		)));
	}

	private substituteVariables(launch: ILaunch | undefined, config: IConfig): TPromise<IConfig> {
		const dbg = this.configurationManager.getDebugger(config.type);
		if (dbg) {
			let folder: IWorkspaceFolder = undefined;
			if (launch && launch.workspace) {
				folder = launch.workspace;
			} else {
				const folders = this.contextService.getWorkspace().folders;
				if (folders.length === 1) {
					folder = folders[0];
				}
			}
			return dbg.substituteVariables(folder, config).then(config => {
				return config;
			}, (err: Error) => {
				this.showError(err.message);
				return undefined;	// bail out
			});
		}
		return TPromise.as(config);
	}

	private createSession(launch: ILaunch, config: IConfig, unresolvedConfig: IConfig, sessionId: string): TPromise<void> {
		return this.textFileService.saveAll().then(() =>
			this.substituteVariables(launch, config).then(resolvedConfig => {

				if (!resolvedConfig) {
					// User canceled resolving of interactive variables, silently return
					return undefined;
				}

				if (!this.configurationManager.getDebugger(resolvedConfig.type) || (config.request !== 'attach' && config.request !== 'launch')) {
					let message: string;
					if (config.request !== 'attach' && config.request !== 'launch') {
						message = config.request ? nls.localize('debugRequestNotSupported', "Attribute '{0}' has an unsupported value '{1}' in the chosen debug configuration.", 'request', config.request)
							: nls.localize('debugRequesMissing', "Attribute '{0}' is missing from the chosen debug configuration.", 'request');

					} else {
						message = resolvedConfig.type ? nls.localize('debugTypeNotSupported', "Configured debug type '{0}' is not supported.", resolvedConfig.type) :
							nls.localize('debugTypeMissing', "Missing property 'type' for the chosen launch configuration.");
					}

					return this.showError(message);
				}

				const workspace = launch ? launch.workspace : undefined;
				return this.runTask(sessionId, workspace, resolvedConfig.preLaunchTask, resolvedConfig, unresolvedConfig,
					() => this.doCreateSession(workspace, { resolved: resolvedConfig, unresolved: unresolvedConfig }, sessionId)
				);
			}, err => {
				if (err && err.message) {
					return this.showError(err.message);
				}
				if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
					return this.showError(nls.localize('noFolderWorkspaceDebugError', "The active file can not be debugged. Make sure it is saved on disk and that you have a debug extension installed for that file type."));
				}

				return launch && launch.openConfigFile(false).then(editor => void 0);
			})
		);
	}

	private doCreateSession(root: IWorkspaceFolder, configuration: { resolved: IConfig, unresolved: IConfig }, sessionId: string): TPromise<any> {

		const resolved = configuration.resolved;
		resolved.__sessionId = sessionId;

		const dbgr = this.configurationManager.getDebugger(resolved.type);
		const session = this.instantiationService.createInstance(Session, sessionId, configuration, root, this.model);
		this.allSessions.set(sessionId, session);
		return session.initialize(dbgr).then(() => {
			this.registerSessionListeners(session);
			const raw = <RawDebugSession>session.raw;
			return (resolved.request === 'attach' ? raw.attach(resolved) : raw.launch(resolved))
				.then((result: DebugProtocol.Response) => {
					if (raw.disconnected) {
						return TPromise.as(null);
					}
					this.focusStackFrame(undefined, undefined, session);
					this._onDidNewSession.fire(session);

					const internalConsoleOptions = resolved.internalConsoleOptions || this.configurationService.getValue<IDebugConfiguration>('debug').internalConsoleOptions;
					if (internalConsoleOptions === 'openOnSessionStart' || (this.firstSessionStart && internalConsoleOptions === 'openOnFirstSessionStart')) {
						this.panelService.openPanel(REPL_ID, false).done(undefined, errors.onUnexpectedError);
					}

					const openDebug = this.configurationService.getValue<IDebugConfiguration>('debug').openDebug;
					// Open debug viewlet based on the visibility of the side bar and openDebug setting
					if (openDebug === 'openOnSessionStart' || (openDebug === 'openOnFirstSessionStart' && this.firstSessionStart)) {
						this.viewletService.openViewlet(VIEWLET_ID);
					}
					this.firstSessionStart = false;

					this.debugType.set(resolved.type);
					if (this.model.getSessions().length > 1) {
						this.viewModel.setMultiSessionView(true);
					}

					/* __GDPR__
						"debugSessionStart" : {
							"type": { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
							"breakpointCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
							"exceptionBreakpoints": { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
							"watchExpressionsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
							"extensionName": { "classification": "PublicNonPersonalData", "purpose": "FeatureInsight" },
							"isBuiltin": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true},
							"launchJsonExists": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
						}
					*/
					return this.telemetryService.publicLog('debugSessionStart', {
						type: resolved.type,
						breakpointCount: this.model.getBreakpoints().length,
						exceptionBreakpoints: this.model.getExceptionBreakpoints(),
						watchExpressionsCount: this.model.getWatchExpressions().length,
						extensionName: dbgr.extensionDescription.id,
						isBuiltin: dbgr.extensionDescription.isBuiltin,
						launchJsonExists: root && !!this.configurationService.getValue<IGlobalConfig>('launch', { resource: root.uri })
					});
				}).then(() => session, (error: Error | string) => {
					if (errors.isPromiseCanceledError(error)) {
						// Do not show 'canceled' error messages to the user #7906
						return TPromise.as(null);
					}

					const errorMessage = error instanceof Error ? error.message : error;
					/* __GDPR__
						"debugMisconfiguration" : {
							"type" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
							"error": { "classification": "CallstackOrException", "purpose": "FeatureInsight" }
						}
					*/
					this.telemetryService.publicLog('debugMisconfiguration', { type: resolved ? resolved.type : undefined, error: errorMessage });
					if (!raw.disconnected) {
						raw.disconnect();
					} else if (session) {
						dispose(session);
					}

					// Show the repl if some error got logged there #5870
					if (this.model.getReplElements().length > 0) {
						this.panelService.openPanel(REPL_ID, false).done(undefined, errors.onUnexpectedError);
					}

					this.showError(errorMessage, errors.isErrorWithActions(error) ? error.actions : []);
					return undefined;
				});
		});
	}

	private onStateChange(): void {
		const state = this.state;
		if (this.previousState !== state) {
			const stateLabel = State[state];
			if (stateLabel) {
				this.debugState.set(stateLabel.toLowerCase());
				this.inDebugMode.set(state !== State.Inactive);
			}
			this.previousState = state;
			this._onDidChangeState.fire(state);
		}
	}

	private registerSessionListeners(session: Session): void {
		const toDispose: IDisposable[] = [];

		toDispose.push(session.onDidChangeState((state) => {
			if (state === State.Running && this.viewModel.focusedSession.getId() === session.getId()) {
				this.focusStackFrame(undefined);
			}
			this.onStateChange();
		}));

		toDispose.push(session.onDidExitAdapter(() => {
			// 'Run without debugging' mode VSCode must terminate the extension host. More details: #3905
			if (equalsIgnoreCase(session.configuration.type, 'extensionhost') && session.state === State.Running && session.configuration.noDebug) {
				this.broadcastService.broadcast({
					channel: EXTENSION_CLOSE_EXTHOST_BROADCAST_CHANNEL,
					payload: [session.root.uri.fsPath]
				});
			}


			const breakpoints = this.model.getBreakpoints();
			/* __GDPR__
				"debugSessionStop" : {
					"type" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
					"success": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
					"sessionLengthInSeconds": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
					"breakpointCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
					"watchExpressionsCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
				}
			*/
			this.telemetryService.publicLog('debugSessionStop', {
				type: session && session.configuration.type,
				success: (<RawDebugSession>session.raw).emittedStopped || breakpoints.length === 0,
				sessionLengthInSeconds: (<RawDebugSession>session.raw).getLengthInSeconds(),
				breakpointCount: breakpoints.length,
				watchExpressionsCount: this.model.getWatchExpressions().length
			});

			if (session.configuration.postDebugTask) {
				this.doRunTask(session.getId(), session.root, session.configuration.postDebugTask).done(undefined, err =>
					this.notificationService.error(err)
				);
			}
			toDispose.push(session);
			dispose(toDispose);
			this._onDidEndSession.fire(session);

			const focusedSession = this.viewModel.focusedSession;
			if (focusedSession && focusedSession.getId() === session.getId()) {
				this.focusStackFrame(null);
			}

			if (this.model.getSessions().length === 0) {
				this.debugType.reset();
				this.viewModel.setMultiSessionView(false);

				if (this.partService.isVisible(Parts.SIDEBAR_PART) && this.configurationService.getValue<IDebugConfiguration>('debug').openExplorerOnEnd) {
					this.viewletService.openViewlet(EXPLORER_VIEWLET_ID).done(null, errors.onUnexpectedError);
				}
			}

		}));
	}

	private showError(message: string, actions: IAction[] = []): TPromise<any> {
		const configureAction = this.instantiationService.createInstance(debugactions.ConfigureAction, debugactions.ConfigureAction.ID, debugactions.ConfigureAction.LABEL);
		actions.push(configureAction);
		return this.dialogService.show(severity.Error, message, actions.map(a => a.label).concat(nls.localize('cancel', "Cancel")), { cancelId: actions.length }).then(choice => {
			if (choice < actions.length) {
				return actions[choice].run();
			}

			return TPromise.as(null);
		});
	}

	private runTask(sessionId: string, root: IWorkspaceFolder, taskId: string | TaskIdentifier, config: IConfig, unresolvedConfig: IConfig, onSuccess: () => TPromise<any>): TPromise<any> {
		const debugAnywayAction = new Action('debug.debugAnyway', nls.localize('debugAnyway', "Debug Anyway"), undefined, true, () => {
			return this.doCreateSession(root, { resolved: config, unresolved: unresolvedConfig }, sessionId);
		});

		return this.doRunTask(sessionId, root, taskId).then((taskSummary: ITaskSummary) => {
			const errorCount = config.preLaunchTask ? this.markerService.getStatistics().errors : 0;
			const successExitCode = taskSummary && taskSummary.exitCode === 0;
			const failureExitCode = taskSummary && taskSummary.exitCode !== undefined && taskSummary.exitCode !== 0;
			if (successExitCode || (errorCount === 0 && !failureExitCode)) {
				return onSuccess();
			}

			const message = errorCount > 1 ? nls.localize('preLaunchTaskErrors', "Build errors have been detected during preLaunchTask '{0}'.", config.preLaunchTask) :
				errorCount === 1 ? nls.localize('preLaunchTaskError', "Build error has been detected during preLaunchTask '{0}'.", config.preLaunchTask) :
					nls.localize('preLaunchTaskExitCode', "The preLaunchTask '{0}' terminated with exit code {1}.", config.preLaunchTask, taskSummary.exitCode);

			const showErrorsAction = new Action('debug.showErrors', nls.localize('showErrors', "Show Errors"), undefined, true, () => {
				return this.panelService.openPanel(Constants.MARKERS_PANEL_ID).then(() => undefined);
			});

			return this.showError(message, [debugAnywayAction, showErrorsAction]);
		}, (err: TaskError) => {
			return this.showError(err.message, [debugAnywayAction, this.taskService.configureAction()]);
		});
	}

	private doRunTask(sessionId: string, root: IWorkspaceFolder, taskId: string | TaskIdentifier): TPromise<ITaskSummary> {
		if (!taskId || this.skipRunningTask) {
			this.skipRunningTask = false;
			return TPromise.as(null);
		}
		// run a task before starting a debug session
		return this.taskService.getTask(root, taskId).then(task => {
			if (!task) {
				const errorMessage = typeof taskId === 'string'
					? nls.localize('DebugTaskNotFoundWithTaskId', "Could not find the task '{0}'.", taskId)
					: nls.localize('DebugTaskNotFound', "Could not find the specified task.");
				return TPromise.wrapError(errors.create(errorMessage));
			}

			function once(kind: TaskEventKind, event: Event<TaskEvent>): Event<TaskEvent> {
				return (listener, thisArgs = null, disposables?) => {
					const result = event(e => {
						if (e.kind === kind) {
							result.dispose();
							return listener.call(thisArgs, e);
						}
					}, null, disposables);
					return result;
				};
			}
			// If a task is missing the problem matcher the promise will never complete, so we need to have a workaround #35340
			let taskStarted = false;
			const promise = this.taskService.getActiveTasks().then(tasks => {
				if (tasks.filter(t => t._id === task._id).length) {
					// task is already running - nothing to do.
					return TPromise.as(null);
				}
				once(TaskEventKind.Active, this.taskService.onDidStateChange)((taskEvent) => {
					taskStarted = true;
				});
				const taskPromise = this.taskService.run(task);
				if (task.isBackground) {
					return new TPromise((c, e) => once(TaskEventKind.Inactive, this.taskService.onDidStateChange)(() => c(null)));
				}

				return taskPromise;
			});

			return new TPromise((c, e) => {
				promise.then(result => {
					taskStarted = true;
					c(result);
				}, error => e(error));

				setTimeout(() => {
					if (!taskStarted) {
						const errorMessage = typeof taskId === 'string'
							? nls.localize('taskNotTrackedWithTaskId', "The specified task cannot be tracked.")
							: nls.localize('taskNotTracked', "The task '{0}' cannot be tracked.", taskId);
						e({ severity: severity.Error, message: errorMessage });
					}
				}, 10000);
			});
		});
	}

	sourceIsNotAvailable(uri: uri): void {
		this.model.sourceIsNotAvailable(uri);
	}

	restartSession(session: ISession, restartData?: any): TPromise<any> {
		return this.textFileService.saveAll().then(() => {
			const unresolvedConfiguration = (<Session>session).unresolvedConfiguration;
			if (session.raw.capabilities.supportsRestartRequest) {
				return this.runTask(session.getId(), session.root, session.configuration.postDebugTask, session.configuration, unresolvedConfiguration,
					() => this.runTask(session.getId(), session.root, session.configuration.preLaunchTask, session.configuration, unresolvedConfiguration,
						() => session.raw.custom('restart', null)));
			}

			const focusedSession = this.viewModel.focusedSession;
			const preserveFocus = focusedSession && session.getId() === focusedSession.getId();
			// Do not run preLaunch and postDebug tasks for automatic restarts
			this.skipRunningTask = !!restartData;

			if (equalsIgnoreCase(session.configuration.type, 'extensionHost') && session.root) {
				return this.broadcastService.broadcast({
					channel: EXTENSION_RELOAD_BROADCAST_CHANNEL,
					payload: [session.root.uri.fsPath]
				});
			}

			// If the restart is automatic disconnect, otherwise send the terminate signal #55064
			return (!!restartData ? session.raw.disconnect(true) : session.raw.terminate(true)).then(() => {

				return new TPromise<void>((c, e) => {
					setTimeout(() => {
						// Read the configuration again if a launch.json has been changed, if not just use the inmemory configuration
						let configToUse = session.configuration;

						const launch = session.root ? this.configurationManager.getLaunch(session.root.uri) : undefined;
						if (launch) {
							const config = launch.getConfiguration(session.configuration.name);
							if (config && !equals(config, unresolvedConfiguration)) {
								// Take the type from the session since the debug extension might overwrite it #21316
								configToUse = config;
								configToUse.type = session.configuration.type;
								configToUse.noDebug = session.configuration.noDebug;
							}
						}
						configToUse.__restart = restartData;
						this.skipRunningTask = !!restartData;
						this.startDebugging(launch, configToUse, configToUse.noDebug, unresolvedConfiguration).then(() => c(null), err => e(err));
					}, 300);
				});
			}).then(() => {
				if (preserveFocus) {
					// Restart should preserve the focused session
					const restartedSession = this.model.getSessions().filter(p => p.configuration.name === session.configuration.name).pop();
					if (restartedSession && restartedSession !== this.viewModel.focusedSession) {
						this.focusStackFrame(undefined, undefined, restartedSession);
					}
				}
			});
		});
	}

	stopSession(session: ISession): TPromise<any> {
		if (session) {
			return session.raw.terminate();
		}

		const sessions = this.model.getSessions();
		if (sessions.length) {
			return TPromise.join(sessions.map(s => s.raw.terminate(false)));
		}

		this._onDidChangeState.fire();
		return undefined;
	}

	getModel(): IModel {
		return this.model;
	}

	getViewModel(): IViewModel {
		return this.viewModel;
	}

	getConfigurationManager(): IConfigurationManager {
		return this.configurationManager;
	}

	private sendAllBreakpoints(session?: ISession): TPromise<any> {
		return TPromise.join(distinct(this.model.getBreakpoints(), bp => bp.uri.toString()).map(bp => this.sendBreakpoints(bp.uri, false, session)))
			.then(() => this.sendFunctionBreakpoints(session))
			// send exception breakpoints at the end since some debug adapters rely on the order
			.then(() => this.sendExceptionBreakpoints(session));
	}

	private sendBreakpoints(modelUri: uri, sourceModified = false, session?: ISession): TPromise<void> {

		const sendBreakpointsToSession = (session: ISession): TPromise<void> => {
			const raw = <RawDebugSession>session.raw;
			if (!raw.readyForBreakpoints) {
				return TPromise.as(null);
			}

			const breakpointsToSend = this.model.getBreakpoints({ uri: modelUri, enabledOnly: true });

			const source = session.getSourceForUri(modelUri);
			let rawSource: DebugProtocol.Source;
			if (source) {
				rawSource = source.raw;
			} else {
				const data = Source.getEncodedDebugData(modelUri);
				rawSource = { name: data.name, path: data.path, sourceReference: data.sourceReference };
			}

			if (breakpointsToSend.length && !rawSource.adapterData) {
				rawSource.adapterData = breakpointsToSend[0].adapterData;
			}
			// Normalize all drive letters going out from vscode to debug adapters so we are consistent with our resolving #43959
			rawSource.path = normalizeDriveLetter(rawSource.path);

			return raw.setBreakpoints({
				source: rawSource,
				lines: breakpointsToSend.map(bp => bp.lineNumber),
				breakpoints: breakpointsToSend.map(bp => ({ line: bp.lineNumber, column: bp.column, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage })),
				sourceModified
			}).then(response => {
				if (!response || !response.body) {
					return;
				}

				const data = Object.create(null);
				for (let i = 0; i < breakpointsToSend.length; i++) {
					data[breakpointsToSend[i].getId()] = response.body.breakpoints[i];
				}
				this.model.setBreakpointSessionData(session.getId(), data);
			});
		};

		return this.sendToOneOrAllSessions(session, sendBreakpointsToSession);
	}

	private sendFunctionBreakpoints(session?: ISession): TPromise<void> {
		const sendFunctionBreakpointsToSession = (session: ISession): TPromise<void> => {
			const raw = <RawDebugSession>session.raw;
			if (!raw.readyForBreakpoints || !raw.capabilities.supportsFunctionBreakpoints) {
				return TPromise.as(null);
			}

			const breakpointsToSend = this.model.getFunctionBreakpoints().filter(fbp => fbp.enabled && this.model.areBreakpointsActivated());
			return raw.setFunctionBreakpoints({ breakpoints: breakpointsToSend }).then(response => {
				if (!response || !response.body) {
					return;
				}

				const data = Object.create(null);
				for (let i = 0; i < breakpointsToSend.length; i++) {
					data[breakpointsToSend[i].getId()] = response.body.breakpoints[i];
				}
				this.model.setBreakpointSessionData(session.getId(), data);
			});
		};

		return this.sendToOneOrAllSessions(session, sendFunctionBreakpointsToSession);
	}

	private sendExceptionBreakpoints(session?: ISession): TPromise<void> {
		const sendExceptionBreakpointsToSession = (session: ISession): TPromise<any> => {
			const raw = <RawDebugSession>session.raw;
			if (!raw.readyForBreakpoints || this.model.getExceptionBreakpoints().length === 0) {
				return TPromise.as(null);
			}

			const enabledExceptionBps = this.model.getExceptionBreakpoints().filter(exb => exb.enabled);
			return raw.setExceptionBreakpoints({ filters: enabledExceptionBps.map(exb => exb.filter) });
		};

		return this.sendToOneOrAllSessions(session, sendExceptionBreakpointsToSession);
	}

	private sendToOneOrAllSessions(session: ISession, send: (session: ISession) => TPromise<void>): TPromise<void> {
		if (session) {
			return send(session);
		}

		return TPromise.join(this.model.getSessions().map(s => send(s))).then(() => void 0);
	}

	private onFileChanges(fileChangesEvent: FileChangesEvent): void {
		const toRemove = this.model.getBreakpoints().filter(bp =>
			fileChangesEvent.contains(bp.uri, FileChangeType.DELETED));
		if (toRemove.length) {
			this.model.removeBreakpoints(toRemove);
		}

		fileChangesEvent.getUpdated().forEach(event => {

			if (this.breakpointsToSendOnResourceSaved.delete(event.resource.toString())) {
				this.sendBreakpoints(event.resource, true).done(null, errors.onUnexpectedError);
			}
		});
	}

	private store(): void {
		const breakpoints = this.model.getBreakpoints();
		if (breakpoints.length) {
			this.storageService.store(DEBUG_BREAKPOINTS_KEY, JSON.stringify(breakpoints), StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(DEBUG_BREAKPOINTS_KEY, StorageScope.WORKSPACE);
		}

		if (!this.model.areBreakpointsActivated()) {
			this.storageService.store(DEBUG_BREAKPOINTS_ACTIVATED_KEY, 'false', StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(DEBUG_BREAKPOINTS_ACTIVATED_KEY, StorageScope.WORKSPACE);
		}

		const functionBreakpoints = this.model.getFunctionBreakpoints();
		if (functionBreakpoints.length) {
			this.storageService.store(DEBUG_FUNCTION_BREAKPOINTS_KEY, JSON.stringify(functionBreakpoints), StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(DEBUG_FUNCTION_BREAKPOINTS_KEY, StorageScope.WORKSPACE);
		}

		const exceptionBreakpoints = this.model.getExceptionBreakpoints();
		if (exceptionBreakpoints.length) {
			this.storageService.store(DEBUG_EXCEPTION_BREAKPOINTS_KEY, JSON.stringify(exceptionBreakpoints), StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(DEBUG_EXCEPTION_BREAKPOINTS_KEY, StorageScope.WORKSPACE);
		}

		const watchExpressions = this.model.getWatchExpressions();
		if (watchExpressions.length) {
			this.storageService.store(DEBUG_WATCH_EXPRESSIONS_KEY, JSON.stringify(watchExpressions.map(we => ({ name: we.name, id: we.getId() }))), StorageScope.WORKSPACE);
		} else {
			this.storageService.remove(DEBUG_WATCH_EXPRESSIONS_KEY, StorageScope.WORKSPACE);
		}
	}

	dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}
}
