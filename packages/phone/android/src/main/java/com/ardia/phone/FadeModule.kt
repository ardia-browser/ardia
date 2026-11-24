package com.ardia.phone

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FadeModule : Module() {
    private fun FadeEdge?.edge(): FadeRamps.Edge? = this?.let { FadeRamps.Edge(it.length.toFloat(), it.floor.toFloat()) }

    override fun definition() = ModuleDefinition {
        Name("ArdiaPhoneFade")

        View(FadeView::class) {
            Prop("topFade") { view: FadeView, edge: FadeEdge? -> view.top = edge.edge() }
            Prop("bottomFade") { view: FadeView, edge: FadeEdge? -> view.bottom = edge.edge() }
            Prop("leadingFade") { view: FadeView, edge: FadeEdge? -> view.leading = edge.edge() }
            Prop("trailingFade") { view: FadeView, edge: FadeEdge? -> view.trailing = edge.edge() }
            OnViewDidUpdateProps { view -> view.update() }
        }
    }
}
