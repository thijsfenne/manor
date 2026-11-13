import ExpoModulesCore

private let enabledNotification = Notification.Name("ManorComposerImagePasteEnabled")
private let pastedNotification = Notification.Name("ManorComposerImagePasted")
private let pastedEvent = "onImagePaste"

public final class ManorImagePasteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ManorImagePaste")

    Events(pastedEvent)

    OnStartObserving(pastedEvent) {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.handlePaste),
        name: pastedNotification,
        object: nil
      )
    }

    OnStopObserving(pastedEvent) {
      NotificationCenter.default.removeObserver(self, name: pastedNotification, object: nil)
    }

    Function("setEnabled") { (enabled: Bool) in
      DispatchQueue.main.async {
        NotificationCenter.default.post(name: enabledNotification, object: enabled)
      }
    }
  }

  @objc private func handlePaste(_ notification: Notification) {
    guard let payload = notification.userInfo as? [String: String] else {
      return
    }
    sendEvent(pastedEvent, payload)
  }
}
