/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CSSResultGroup,
  LitElement,
  PropertyValues,
  TemplateResult,
  html,
  unsafeCSS,
} from 'lit';
import { customElement, property, query, state } from 'lit/decorators';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { until } from 'lit/directives/until';
import {
  HomeAssistant,
  LovelaceCardEditor,
  getLovelace,
  handleAction,
} from 'custom-card-helpers';
import screenfull from 'screenfull';

import { entitySchema, frigateCardConfigSchema } from './types';
import type {
  BrowseMediaQueryParameters,
  Entity,
  ExtendedHomeAssistant,
  FrigateCardConfig,
  MediaLoadInfo,
  MenuButton,
  Message,
} from './types';

import { CARD_VERSION, REPO_URL } from './const';
import { FrigateCardMenu, MENU_HEIGHT } from './components/menu';
import { View } from './view';
import {
  homeAssistantWSRequest,
  shouldUpdateBasedOnHass,
} from './common';
import { localize } from './localize/localize';
import { renderMessage, renderProgressIndicator } from './components/message';

import './editor';
import './components/elements';
import './components/gallery';
import './components/live';
import './components/menu';
import './components/message';
import './components/viewer';
import './patches/ha-camera-stream';
import './patches/ha-hls-player';

import cardStyle from './scss/card.scss';
import { FrigateCardElements } from './components/elements';

const MEDIA_HEIGHT_CUTOFF = 50;
const MEDIA_WIDTH_CUTOFF = MEDIA_HEIGHT_CUTOFF;

/** A note on media callbacks:
 *
 * We need media elements (e.g. <video>, <img> or <canvas>) to callback when:
 *  - Metadata is loaded / dimensions are known (for aspect-ratio)
 *  - Media is playing / paused (to avoid reloading)
 *
 * There are a number of different approaches used to attach event handlers to
 * get these callbacks (which need to be attached directly to the media
 * elements, which may be 'buried' down the DOM):
 *  - Extend the `ha-hls-player` and `ha-camera-stream` to specify the required
 *    hooks (as querySelecting the media elements after rendering was a fight
 *    with the Lit rendering engine and was very fragile) .
 *  - For non-Lit elements (e.g. WebRTC) query selecting after rendering.
 *  - Library provided hooks (e.g. JSMPEG)
 *  - Directly specifying hooks (e.g. for snapshot viewing with simple <img> tags)
 */

/* eslint no-console: 0 */
console.info(
  `%c  FRIGATE-HASS-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}    `,
  'color: pink; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

// This puts your card into the UI card picker dialog
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'frigate-card',
  name: localize('common.frigate_card'),
  description: localize('common.frigate_card_description'),
  preview: true,
  documentationURL: REPO_URL,
});

// Main FrigateCard class.
@customElement('frigate-card')
export class FrigateCard extends LitElement {
  @property({ attribute: false })
  protected _hass: (HomeAssistant & ExtendedHomeAssistant) | null = null;

  @state()
  public config!: FrigateCardConfig;

  protected _interactionTimerID: number | null = null;

  @property({ attribute: false })
  protected _view: View = new View();

  @query('frigate-card-menu')
  _menu!: FrigateCardMenu;

  @query('frigate-card-elements')
  _elements!: FrigateCardElements;

  // Whether or not media is actively playing (live or clip).
  protected _mediaPlaying = false;

  // A small cache to avoid needing to create a new list of entities every time
  // a hass update arrives.
  protected _entitiesToMonitor: string[] | null = null;

  // Information about the most recently loaded media item.
  protected _mediaInfo: MediaLoadInfo | null = null;

  // The frigate camera name to use (may be manually specified or automatically
  // derived).
  protected _frigateCameraName: string | null = null;

  // Error/info message to render.
  protected _message: Message | null = null;

  set hass(hass: HomeAssistant & ExtendedHomeAssistant) {
    this._hass = hass;

    // Manually set hass in the menu & elements. This is to allow these to
    // update, without necessarily re-rendering the entire card (re-rendering
    // interrupts clip playing).
    if (this._hass) {
      if (this._menu) {
        this._menu.hass = this._hass;
      }
      if (this._elements) {
        this._elements.hass = this._hass;
      }
    }
  }

  // Get the configuration element.
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('frigate-card-editor');
  }

  // Get a stub basic config using the first available camera of any kind.
  public static getStubConfig(
    _hass: HomeAssistant,
    entities: string[],
  ): FrigateCardConfig {
    const cameraEntity = entities.find(element => element.startsWith('camera.'));
    return {
      camera_entity: cameraEntity,
    } as FrigateCardConfig;
  }

  protected _getMenuButtons(): MenuButton[] {
    const buttons: MenuButton[] = [];

    if (this.config.menu_buttons?.frigate ?? true) {
      buttons.push({
        type: 'internal-menu-icon',
        card_action: 'frigate',
        title: localize('menu.frigate'),
      });
    }
    if (this.config.menu_buttons?.live ?? true) {
      buttons.push({
        type: 'internal-menu-icon',
        card_action: 'live',
        title: localize('menu.live'),
        icon: 'mdi:cctv',
        emphasize: this._view.is('live'),
      });
    }
    if (this.config.menu_buttons?.clips ?? true) {
      buttons.push({
        type: 'internal-menu-icon',
        card_action: 'clips',
        title: localize('menu.clips'),
        icon: 'mdi:filmstrip',
        emphasize: this._view.is('clips'),
      });
    }
    if (this.config.menu_buttons?.snapshots ?? true) {
      buttons.push({
        type: 'internal-menu-icon',
        card_action: 'snapshots',
        title: localize('menu.snapshots'),
        icon: 'mdi:camera',
        emphasize: this._view.is('snapshots'),
      });
    }
    if ((this.config.menu_buttons?.frigate_ui ?? true) && this.config.frigate_url) {
      buttons.push({
        type: 'internal-menu-icon',
        card_action: 'frigate_ui',
        title: localize('menu.frigate_ui'),
        icon: 'mdi:web',
      });
    }
    if ((this.config.menu_buttons?.fullscreen ?? true) && screenfull.isEnabled) {
      buttons.push({
        type: 'internal-menu-icon',
        card_action: 'fullscreen',
        title: localize('menu.fullscreen'),
        icon: screenfull.isFullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen',
      });
    }
    return buttons;
  }

  protected async _getFrigateCameraName(): Promise<string | null> {
    // No camera name specified, apply two heuristics in this order:
    // - Get the entity information and pull out the camera name from the unique_id.
    // - Apply basic entity name guesswork.

    if (!this._hass || !this.config) {
      return null;
    }

    // Option 1: Name specified in config -> done!
    if (this.config.frigate_camera_name) {
      return this.config.frigate_camera_name;
    }

    if (this.config.camera_entity) {
      // Option 2: Find entity unique_id in registry.
      const request = {
        type: 'config/entity_registry/get',
        entity_id: this.config.camera_entity,
      };
      try {
        const entityResult = await homeAssistantWSRequest<Entity>(
          this._hass,
          entitySchema,
          request,
        );
        if (entityResult && entityResult.platform == 'frigate') {
          const match = entityResult.unique_id.match(/:camera:(?<camera>[^:]+)$/);
          if (match && match.groups) {
            return match.groups['camera'];
          }
        }
      } catch (e: any) {
        // Pass.
      }

      // Option 3: Guess from the entity_id.
      if (this.config.camera_entity.includes('.')) {
        return this.config.camera_entity.split('.', 2)[1];
      }
    }

    return null;
  }

  protected _getParseErrorPathString(path: (string | number)[]): string {
    let out = '';
    for (let i = 0; i < path.length; i++) {
      const item = path[i];
      if (typeof item == 'number') {
        out += '[' + item + ']';
      } else if (out) {
        out += ' -> ' + item;
      } else {
        out = item;
      }
    }
    return out;
  }

  // Set the object configuration.
  public setConfig(inputConfig: FrigateCardConfig): void {
    if (!inputConfig) {
      throw new Error(localize('error.invalid_configuration:'));
    }

    const parseResult = frigateCardConfigSchema.safeParse(inputConfig);
    if (!parseResult.success) {
      let hint = '';
      if (parseResult.error && parseResult.error.issues) {
        hint = this._getParseErrorPathString(parseResult.error.issues[0].path);
      }
      throw new Error(
        localize('error.invalid_configuration') + (hint ? `: ${hint}` : ''),
      );
    }
    const config = parseResult.data;

    if (config.test_gui) {
      getLovelace().setEditMode(true);
    }

    this._frigateCameraName = null;
    this.config = config;

    this._entitiesToMonitor = this.config.update_entities || [];
    if (this.config.camera_entity) {
      this._entitiesToMonitor.push(this.config.camera_entity);
    }
    this._changeView();
  }

  protected _changeView(view?: View | undefined): void {
    this._message = null;

    if (view === undefined) {
      this._view = new View({ view: this.config.view_default });
    } else {
      this._view = view;
    }
  }

  protected _changeViewHandler(e: CustomEvent<View>): void {
    this._changeView(e.detail);
  }

  // Determine whether the card should be updated.
  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false;
    }
    if (changedProps.has('config')) {
      return true;
    }

    const oldHass = changedProps.get('_hass') as HomeAssistant | undefined;
    if (oldHass) {
      // Home Assistant pumps a lot of updates through. Re-rendering the card is
      // necessary at times (e.g. to update the 'clip' view as new clips
      // arrive), but also is a jarring experience for the user (e.g. if they
      // are browsing the mini-gallery). Do not allow re-rendering from a Home
      // Assistant update if there's been recent interaction (e.g. clicks on the
      // card) or if there is media active playing.
      if (this._interactionTimerID || this._mediaPlaying) {
        return false;
      }
      return shouldUpdateBasedOnHass(this._hass, oldHass, this._entitiesToMonitor);
    }
    return true;
  }

  protected _menuActionHandler(action: string, button: MenuButton): void {
    if (button.type != 'internal-menu-icon') {
      handleAction(this, this._hass as HomeAssistant, button, action);
      return;
    }

    switch (button.card_action) {
      case 'frigate':
        this._changeView();
        break;
      case 'live':
      case 'clips':
      case 'snapshots':
        this._changeView(new View({ view: button.card_action }));
        break;
      case 'frigate_ui':
        const frigate_url = this._getFrigateURLFromContext();
        if (frigate_url) {
          window.open(frigate_url);
        }
        break;
      case 'fullscreen':
        if (screenfull.isEnabled) {
          screenfull.toggle(this);
        }
        break;
      default:
        console.warn(`Frigate card received unknown menu action: ${button.card_action}`);
    }
  }

  // Get the Frigate UI url.
  protected _getFrigateURLFromContext(): string | null {
    if (!this.config.frigate_url) {
      return null;
    }
    if (!this._frigateCameraName) {
      return this.config.frigate_url;
    } else if (this._view.is('live')) {
      return `${this.config.frigate_url}/cameras/${this._frigateCameraName}`;
    }
    return `${this.config.frigate_url}/events?camera=${this._frigateCameraName}`;
  }

  // Record interactions with the card.
  protected _interactionHandler(): void {
    if (!this.config.view_timeout) {
      return;
    }
    if (this._interactionTimerID) {
      window.clearTimeout(this._interactionTimerID);
    }
    this._interactionTimerID = window.setTimeout(() => {
      this._interactionTimerID = null;
      this._changeView();
    }, this.config.view_timeout * 1000);
  }

  protected _renderMenu(): TemplateResult | void {
    const classes = {
      'hover-menu': this.config.menu_mode.startsWith('hover-'),
    };
    return html`
      <frigate-card-menu
        class="${classMap(classes)}"
        .hass=${this._hass}
        .actionCallback=${this._menuActionHandler.bind(this)}
        .menuMode=${this.config.menu_mode}
        .buttons=${this._getMenuButtons()}
      ></frigate-card-menu>
    `;
  }

  protected _getBrowseMediaQueryParameters(): BrowseMediaQueryParameters | null {
    if (!this._frigateCameraName) {
      return null;
    }

    return {
      mediaType: this._view.view == 'clips' ? 'clips' : 'snapshots',
      clientId: this.config.frigate_client_id,
      cameraName: this._frigateCameraName,
      label: this.config.label,
      zone: this.config.zone,
    };
  }

  protected _playHandler(): void {
    this._mediaPlaying = true;
  }

  protected _pauseHandler(): void {
    this._mediaPlaying = false;
  }

  protected _setMessageAndUpdate(message: Message): void {
    // Register the first message, or prioritize errors if there's pre-render competition.
    if (!this._message || (message.type == 'error' && this._message.type != 'error')) {
      this._message = message;
      this.requestUpdate();
    }
  }

  protected _messageHandler(e: CustomEvent<Message>): void {
    return this._setMessageAndUpdate(e.detail);
  }

  protected _mediaLoadHandler(e: CustomEvent<MediaLoadInfo>): void {
    const mediaInfo = e.detail;
    // In Safari, with WebRTC, 0x0 is occasionally returned during loading,
    // so treat anything less than a safety cutoff as bogus.
    if (mediaInfo.height < MEDIA_HEIGHT_CUTOFF || mediaInfo.width < MEDIA_WIDTH_CUTOFF) {
      return;
    }
    let requestRefresh = false;
    if (
      this._isAspectRatioEnforced() &&
      (mediaInfo.width != this._mediaInfo?.width ||
        mediaInfo.height != this._mediaInfo?.height)
    ) {
      requestRefresh = true;
    }

    this._mediaInfo = mediaInfo;
    if (requestRefresh) {
      this.requestUpdate();
    }
  }

  protected _fullScreenHandler(): void {
    // Re-render after a change to fullscreen mode to take advantage of
    // the expanded screen real-estate (vs staying in aspect-ratio locked
    // modes).
    this.requestUpdate();
  }
  connectedCallback(): void {
    super.connectedCallback();
    if (screenfull.isEnabled) {
      screenfull.on('change', this._fullScreenHandler.bind(this));
    }
  }
  disconnectedCallback(): void {
    if (screenfull.isEnabled) {
      screenfull.off('change', this._fullScreenHandler.bind(this));
    }
    super.disconnectedCallback();
  }

  protected _isAspectRatioEnforced(): boolean {
    const aspect_ratio_mode = this.config.dimensions?.aspect_ratio_mode ?? 'dynamic';

    // Do not artifically constrain aspect ratio if:
    // - It's fullscreen.
    // - Aspect ratio enforcement is disabled.
    // - Or aspect ratio enforcement is dynamic and it's a media view (i.e. not the gallery).

    return !(
      (screenfull.isEnabled && screenfull.isFullscreen) ||
      aspect_ratio_mode == 'unconstrained' ||
      (aspect_ratio_mode == 'dynamic' && this._view.isMediaView())
    );
  }

  protected _getAspectRatioPadding(): number | null {
    if (!this._isAspectRatioEnforced()) {
      return null;
    }

    const aspect_ratio_mode = this.config.dimensions?.aspect_ratio_mode ?? 'dynamic';
    if (aspect_ratio_mode == 'dynamic' && this._mediaInfo) {
      return (this._mediaInfo.height / this._mediaInfo.width) * 100;
    }

    const default_aspect_ratio = this.config.dimensions?.aspect_ratio;
    if (default_aspect_ratio) {
      return (default_aspect_ratio[1] / default_aspect_ratio[0]) * 100;
    } else {
      return (9 / 16) * 100;
    }
  }

  // Render the call (master render method).
  protected render(): TemplateResult | void {
    if (this.config.show_warning) {
      return this._showWarning(localize('common.show_warning'));
    }
    if (this.config.show_error) {
      return this._showError(localize('common.show_error'));
    }

    const padding = this._getAspectRatioPadding();
    const outerStyle = {},
      innerStyle = {};

    // Padding to force a particular aspect ratio.
    if (padding != null) {
      outerStyle['padding-top'] = `${padding}%`;
    }

    // Special hacky treatment required when:
    //
    // - It's in fullscreen mode
    // - It's viewing a media item
    // - And the aspect ratio of the media item < aspect ratio of the window
    //
    // Cannot seem to scale the video by height in CSS without actually styling
    // the underlying video element (which there is no access to as it's buried
    // past multiple shadow roots), so instead scale the width in terms of'vh'
    // (viewport height) in proportion to the aspect-ratio of the media.
    if (
      screenfull.isEnabled &&
      screenfull.isFullscreen &&
      this._view.isMediaView() &&
      this._mediaInfo &&
      this._mediaInfo.width / this._mediaInfo.height <
        window.innerWidth / window.innerHeight
    ) {
      // If the menu is outside the media (i.e. above/below) allow space for it.
      const allowance = ['above', 'below'].includes(this.config.menu_mode)
        ? MENU_HEIGHT
        : 0;
      innerStyle['max-width'] = `calc(${
        (100 * this._mediaInfo.width) / this._mediaInfo.height
      }vh - ${allowance}px )`;
    }

    const contentClasses = {
      'frigate-card-contents': true,
      absolute: padding != null,
    };

    return html` <ha-card @click=${this._interactionHandler}>
      ${this.config.menu_mode == 'above' ? this._renderMenu() : ''}
      <div class="container outer" style="${styleMap(outerStyle)}">
        <div class="${classMap(contentClasses)}" style="${styleMap(innerStyle)}">
          ${this._message
            ? renderMessage(this._message)
            : until(this._render(), renderProgressIndicator())}
        </div>
      </div>
      ${this.config.menu_mode != 'above' ? this._renderMenu() : ''}
    </ha-card>`;
  }

  protected async _render(): Promise<TemplateResult | void> {
    if (!this._frigateCameraName) {
      this._frigateCameraName = await this._getFrigateCameraName();
    }
    const mediaQueryParameters = this._getBrowseMediaQueryParameters();
    if (!this._hass || !this._frigateCameraName || !mediaQueryParameters) {
      return this._setMessageAndUpdate({
        message: localize('error.no_frigate_camera_name'),
        type: 'error',
      });
    }

    const pictureElementsClasses = {
      'picture-elements': true,
      gallery: this._view.isGalleryView(),
    };

    return html`
      <div class="${classMap(pictureElementsClasses)}">
        ${this._view.is('clips') || this._view.is('snapshots')
          ? html` <frigate-card-gallery
              .hass=${this._hass}
              .view=${this._view}
              .browseMediaQueryParameters=${mediaQueryParameters}
              @frigate-card:change-view=${this._changeViewHandler}
              @frigate-card:message=${this._messageHandler}
            >
            </frigate-card-gallery>`
          : ``}
        ${this._view.is('clip') || this._view.is('snapshot')
          ? html` <frigate-card-viewer
              .hass=${this._hass}
              .view=${this._view}
              .browseMediaQueryParameters=${mediaQueryParameters}
              .nextPreviousControlStyle=${this.config.controls?.nextprev ?? 'thumbnails'}
              .autoplayClip=${this.config.autoplay_clip}
              @frigate-card:change-view=${this._changeViewHandler}
              @frigate-card:media-load=${this._mediaLoadHandler}
              @frigate-card:pause=${this._pauseHandler}
              @frigate-card:play=${this._playHandler}
              @frigate-card:message=${this._messageHandler}
            >
            </frigate-card-viewer>`
          : ``}
        ${this._view.is('live')
          ? html`
              <frigate-card-live
                .hass=${this._hass}
                .config=${this.config}
                .frigateCameraName=${this._frigateCameraName}
                @frigate-card:media-load=${this._mediaLoadHandler}
                @frigate-card:pause=${this._pauseHandler}
                @frigate-card:play=${this._playHandler}
                @frigate-card:message=${this._messageHandler}
              >
              </frigate-card-live>
            `
          : ``}
        ${this.config.elements 
          ? html`
              <frigate-card-elements
                .hass=${this._hass}
                .elements=${this.config.elements}
                @frigate-card:message=${this._messageHandler}
                @frigate-card:menu-add=${(e) => {
                  this._menu.addButton(e.detail);
                }}
                @frigate-card:menu-remove=${(e) => {
                  this._menu.removeButton(e.detail);
                }}
                @frigate-card:state-request=${(e) => {
                  e.view = this._view;
                }}
              >
              </frigate-card-elements>
            `
          : ``}
      </div>
    `;
  }

  // Show a warning card.
  private _showWarning(warning: string): TemplateResult {
    return html` <hui-warning> ${warning} </hui-warning> `;
  }

  // Show an error card.
  private _showError(error: string): TemplateResult {
    const errorCard = document.createElement('hui-error-card');
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config,
    });

    return html` ${errorCard} `;
  }

  // Return compiled CSS styles (thus safe to use with unsafeCSS).
  static get styles(): CSSResultGroup {
    return unsafeCSS(cardStyle);
  }

  // Get the Lovelace card size.
  public getCardSize(): number {
    if (this._mediaInfo) {
      return this._mediaInfo.height / 50;
    }
    return 6;
  }
}
