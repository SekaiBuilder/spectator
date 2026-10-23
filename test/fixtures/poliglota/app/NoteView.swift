import SwiftUI
struct NoteView {
    let store: NoteStore
    func refresh() { _ = store.add(Note(text: "hola"), to: []) }
}
