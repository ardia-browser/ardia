use super::*;

#[derive(Clone, Debug, PartialEq)]
enum Shape {
    Url(String),
    Folder(String, Vec<Shape>),
}

fn u(url: &str) -> Shape {
    Shape::Url(url.to_owned())
}

fn f(title: &str, children: Vec<Shape>) -> Shape {
    Shape::Folder(title.to_owned(), children)
}

fn link(title: &str, url: &str) -> ImportedNode {
    ImportedNode::link(title, url, None)
}

fn folder(title: &str, children: Vec<ImportedNode>) -> ImportedNode {
    ImportedNode::folder(title, children, None)
}

fn with_role(mut node: ImportedNode, role: &str) -> ImportedNode {
    node.role = Some(role.to_owned());
    node
}

fn dia(bar: Vec<ImportedNode>, others: Vec<ImportedNode>) -> ImportedNode {
    folder(
        "",
        vec![
            with_role(folder("Bookmarks bar", bar), "toolbar"),
            with_role(folder("Other bookmarks", others), "other"),
        ],
    )
}

fn dia_bar() -> Vec<ImportedNode> {
    vec![
        link("Mail", "https://mail.example/"),
        folder(
            "Work",
            vec![
                link("Docs", "https://docs.example/"),
                link("Wiki", "https://wiki.example/"),
            ],
        ),
    ]
}

struct Profile {
    tree: BookmarkTree,
    ids: IdGen,
    made: ImportedFolders,
}

impl Profile {
    fn start(own: &[(&str, &str)]) -> Profile {
        let mut tree = BookmarkTree::new("default", 1);
        let ids = IdGen::with_launch("merge");
        let bar = tree.bar();
        for (title, url) in own {
            tree.add_url(&ids, &bar, None, title, url, 1).unwrap();
        }
        Profile {
            tree,
            ids,
            made: ImportedFolders::new(),
        }
    }

    fn import(&mut self, root: ImportedNode, source: &str) -> usize {
        import_into_tree(&mut self.tree, &self.ids, &mut self.made, &root, source, 2).links
    }

    fn shape(&self, id: &str) -> Shape {
        match self.tree.get(id).unwrap() {
            BookmarkNode::Url { url, .. } => Shape::Url(url.clone()),
            BookmarkNode::Folder {
                title, children, ..
            } => Shape::Folder(
                title.clone(),
                children.iter().map(|c| self.shape(c.as_str())).collect(),
            ),
        }
    }

    fn children(&self, id: BookmarkId) -> Vec<Shape> {
        match self.shape(id.as_str()) {
            Shape::Folder(_, children) => children,
            Shape::Url(_) => Vec::new(),
        }
    }

    fn bar(&self) -> Vec<Shape> {
        self.children(self.tree.bar())
    }

    fn other(&self) -> Vec<Shape> {
        self.children(self.tree.other())
    }

    fn child_named(&self, parent: &BookmarkId, title: &str) -> BookmarkId {
        self.tree
            .children(parent.as_str())
            .iter()
            .find(|id| self.tree.get(id.as_str()).unwrap().title() == title)
            .cloned()
            .unwrap()
    }

    fn add_folder(&mut self, parent: &BookmarkId, title: &str) -> BookmarkId {
        self.tree
            .add_folder(&self.ids, parent, None, title, 1)
            .unwrap()
    }

    fn add_link(&mut self, parent: &BookmarkId, url: &str) {
        self.tree
            .add_url(&self.ids, parent, None, url, url, 1)
            .unwrap();
    }
}

#[test]
fn importing_the_same_bookmarks_again_adds_no_second_imported_from_folder() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    let later = || vec![link("Later", "https://later.example/")];
    assert_eq!(p.import(dia(dia_bar(), later()), "Dia"), 4);
    let first = (p.bar(), p.other());
    assert_eq!(
        first.0,
        vec![
            u("https://mine.example/"),
            f(
                "Imported from Dia",
                vec![
                    u("https://mail.example/"),
                    f(
                        "Work",
                        vec![u("https://docs.example/"), u("https://wiki.example/")]
                    ),
                ]
            ),
        ]
    );
    for _ in 0..3 {
        assert_eq!(p.import(dia(dia_bar(), later()), "Dia"), 0);
    }
    assert_eq!((p.bar(), p.other()), first);
}

#[test]
fn a_repeat_import_onto_an_empty_bar_adds_nothing() {
    let mut p = Profile::start(&[]);
    assert_eq!(p.import(dia(dia_bar(), vec![]), "Dia"), 3);
    let first = p.bar();
    assert_eq!(
        first,
        vec![
            u("https://mail.example/"),
            f(
                "Work",
                vec![u("https://docs.example/"), u("https://wiki.example/")]
            ),
        ]
    );
    assert_eq!(p.import(dia(dia_bar(), vec![]), "Dia"), 0);
    assert_eq!(p.bar(), first);
}

#[test]
fn a_repeat_import_brings_only_whats_new_into_the_folders_it_made() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    p.import(dia(dia_bar(), vec![]), "Dia");
    let bar = p.tree.bar();
    let imported = p.child_named(&bar, "Imported from Dia");
    let work = p.child_named(&imported, "Work");
    p.add_link(&work, "https://by-hand.example/");
    let mail = p
        .tree
        .children(imported.as_str())
        .iter()
        .find(|id| matches!(p.tree.get(id.as_str()), Some(BookmarkNode::Url { .. })))
        .cloned()
        .unwrap();
    let other = p.tree.other();
    p.tree.move_node(mail.as_str(), &other, None).unwrap();
    let mut grown = dia_bar();
    grown.push(link("News", "https://news.example/"));
    grown[1] = folder(
        "Work",
        vec![
            link("Docs", "https://docs.example/"),
            link("Wiki", "https://wiki.example/"),
            link("Plan", "https://plan.example/"),
        ],
    );
    assert_eq!(p.import(dia(grown, vec![]), "Dia"), 2);
    assert_eq!(
        p.bar(),
        vec![
            u("https://mine.example/"),
            f(
                "Imported from Dia",
                vec![
                    f(
                        "Work",
                        vec![
                            u("https://docs.example/"),
                            u("https://wiki.example/"),
                            u("https://by-hand.example/"),
                            u("https://plan.example/"),
                        ]
                    ),
                    u("https://news.example/"),
                ]
            ),
        ]
    );
    assert_eq!(p.other(), vec![u("https://mail.example/")]);
}

#[test]
fn another_browser_gets_its_own_folder_and_skips_pages_already_there() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    p.import(dia(dia_bar(), vec![]), "Dia");
    assert_eq!(
        p.import(
            dia(
                vec![
                    link("Docs", "https://DOCS.example/#"),
                    link("Chrome only", "https://chrome.example/"),
                ],
                vec![]
            ),
            "Chrome"
        ),
        1
    );
    assert_eq!(
        p.bar().last().cloned(),
        Some(f(
            "Imported from Chrome",
            vec![u("https://chrome.example/")]
        ))
    );
    assert_eq!(
        p.bar()
            .iter()
            .filter(|n| matches!(n, Shape::Folder(t, _) if t == "Imported from Dia"))
            .count(),
        1
    );
}

#[test]
fn the_sources_own_repeats_and_empty_folders_come_over_on_a_first_import() {
    let mut p = Profile::start(&[]);
    let twice = || {
        vec![
            link("A", "https://a.example/"),
            folder("Again", vec![link("A", "https://a.example/")]),
            folder("Empty", vec![]),
        ]
    };
    assert_eq!(p.import(dia(twice(), vec![]), "Dia"), 2);
    assert_eq!(
        p.bar(),
        vec![
            u("https://a.example/"),
            f("Again", vec![u("https://a.example/")]),
            f("Empty", vec![]),
        ]
    );
    assert_eq!(p.import(dia(twice(), vec![]), "Dia"), 0);
    assert_eq!(p.bar().len(), 3);
}

#[test]
fn two_folders_of_the_same_name_each_take_their_own_new_links() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    let nested = |a: Vec<ImportedNode>, b: Vec<ImportedNode>| {
        let mut first = vec![link("A", "https://a.example/")];
        first.extend(a);
        let mut second = vec![link("B", "https://b.example/")];
        second.extend(b);
        vec![folder(
            "Top",
            vec![folder("Same", first), folder("Same", second)],
        )]
    };
    p.import(dia(nested(vec![], vec![]), vec![]), "Dia");
    assert_eq!(
        p.import(
            dia(
                nested(
                    vec![link("A2", "https://a2.example/")],
                    vec![link("B2", "https://b2.example/")]
                ),
                vec![]
            ),
            "Dia"
        ),
        2
    );
    assert_eq!(
        p.bar()[1],
        f(
            "Imported from Dia",
            vec![f(
                "Top",
                vec![
                    f(
                        "Same",
                        vec![u("https://a.example/"), u("https://a2.example/")]
                    ),
                    f(
                        "Same",
                        vec![u("https://b.example/"), u("https://b2.example/")]
                    ),
                ]
            )]
        )
    );
}

#[test]
fn a_folder_that_went_straight_onto_the_bar_keeps_taking_its_new_links() {
    let mut p = Profile::start(&[]);
    let work = |more: Vec<ImportedNode>| {
        let mut children = vec![
            link("Docs", "https://docs.example/"),
            link("Wiki", "https://wiki.example/"),
        ];
        children.extend(more);
        folder("Work", children)
    };
    p.import(dia(vec![work(vec![])], vec![]), "Dia");
    p.import(
        dia(
            vec![
                work(vec![link("Plan", "https://plan.example/")]),
                link("News", "https://news.example/"),
            ],
            vec![],
        ),
        "Dia",
    );
    p.import(
        dia(
            vec![
                work(vec![
                    link("Plan", "https://plan.example/"),
                    link("Ship", "https://ship.example/"),
                ]),
                link("News", "https://news.example/"),
            ],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.bar(),
        vec![
            f(
                "Work",
                vec![
                    u("https://docs.example/"),
                    u("https://wiki.example/"),
                    u("https://plan.example/"),
                    u("https://ship.example/"),
                ]
            ),
            f("Imported from Dia", vec![u("https://news.example/")]),
        ]
    );
}

#[test]
fn another_browsers_folder_sharing_a_link_gets_its_own_imported_from_folder() {
    let mut p = Profile::start(&[]);
    p.import(
        dia(
            vec![folder(
                "Work",
                vec![
                    link("Docs", "https://docs.example/"),
                    link("Wiki", "https://wiki.example/"),
                ],
            )],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.import(
            dia(
                vec![folder(
                    "Work",
                    vec![
                        link("Docs", "https://docs.example/"),
                        link("Chrome", "https://chrome.example/"),
                        link("Mail", "https://mail.example/"),
                    ],
                )],
                vec![]
            ),
            "Chrome"
        ),
        2
    );
    assert_eq!(
        p.bar(),
        vec![
            f(
                "Work",
                vec![u("https://docs.example/"), u("https://wiki.example/")]
            ),
            f(
                "Imported from Chrome",
                vec![f(
                    "Work",
                    vec![u("https://chrome.example/"), u("https://mail.example/")]
                )]
            ),
        ]
    );
}

#[test]
fn empty_folders_come_over_once() {
    let mut p = Profile::start(&[]);
    let empties = || vec![folder("Empty", vec![]), folder("Also empty", vec![])];
    assert_eq!(p.import(dia(empties(), vec![]), "Dia"), 0);
    assert_eq!(p.bar(), vec![f("Empty", vec![]), f("Also empty", vec![])]);
    assert_eq!(p.import(dia(empties(), vec![]), "Dia"), 0);
    assert_eq!(p.bar().len(), 2);
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    p.import(dia(dia_bar(), vec![]), "Dia");
    let mut more = dia_bar();
    more.push(folder("Ideas", vec![]));
    p.import(dia(more.clone(), vec![]), "Dia");
    let Shape::Folder(_, inside) = p.bar()[1].clone() else {
        panic!("a wrapper");
    };
    assert_eq!(inside.last().cloned(), Some(f("Ideas", vec![])));
    p.import(dia(more, vec![]), "Dia");
    let Shape::Folder(_, inside) = p.bar()[1].clone() else {
        panic!("a wrapper");
    };
    assert_eq!(
        inside
            .iter()
            .filter(|n| matches!(n, Shape::Folder(t, _) if t == "Ideas"))
            .count(),
        1
    );
}

#[test]
fn default_ports_and_leading_zeros_name_the_same_page() {
    assert_eq!(
        page_key("https://Port.example:0443/"),
        "https://port.example/"
    );
    assert_eq!(
        page_key("http://port.example:080/x"),
        "http://port.example/x"
    );
    assert_eq!(
        page_key("https://port.example:08443/"),
        "https://port.example:8443/"
    );
    assert_eq!(page_key("https://port.example:/"), "https://port.example/");
    assert_eq!(
        page_key("https://user:Pw@[::1]:0443/"),
        "https://user:Pw@[::1]/"
    );
    let mut p = Profile::start(&[
        ("Port", "https://port.example/"),
        ("Plain", "http://plain.example/a"),
    ]);
    assert_eq!(
        p.import(
            dia(
                vec![
                    link("Port", "https://port.example:443/"),
                    link("Plain", "HTTP://Plain.Example:80/a"),
                    link("Other port", "https://port.example:8443/"),
                ],
                vec![]
            ),
            "Dia"
        ),
        1
    );
    assert_eq!(
        p.bar().last().cloned(),
        Some(f(
            "Imported from Dia",
            vec![u("https://port.example:8443/")]
        ))
    );
}

#[test]
fn another_browsers_folder_on_the_bar_never_takes_a_dia_import() {
    let mut p = Profile::start(&[]);
    p.import(
        dia(
            vec![folder("Work", vec![link("A", "https://a.example/")])],
            vec![],
        ),
        "Chrome",
    );
    assert_eq!(
        p.import(
            dia(
                vec![folder(
                    "Work",
                    vec![
                        link("A", "https://a.example/"),
                        link("B", "https://b.example/")
                    ]
                )],
                vec![]
            ),
            "Dia"
        ),
        1
    );
    assert_eq!(
        p.bar(),
        vec![
            f("Work", vec![u("https://a.example/")]),
            f(
                "Imported from Dia",
                vec![f("Work", vec![u("https://b.example/")])]
            ),
        ]
    );
}

#[test]
fn an_empty_folder_an_import_made_takes_links_added_later() {
    let mut p = Profile::start(&[]);
    p.import(
        dia(
            vec![
                folder("Work", vec![]),
                link("Mail", "https://mail.example/"),
            ],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.import(
            dia(
                vec![
                    folder("Work", vec![link("A", "https://a.example/")]),
                    link("Mail", "https://mail.example/"),
                ],
                vec![]
            ),
            "Dia"
        ),
        1
    );
    assert_eq!(
        p.bar(),
        vec![
            f("Work", vec![u("https://a.example/")]),
            u("https://mail.example/")
        ]
    );
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    p.import(dia(vec![folder("Later", vec![])], vec![]), "Dia");
    p.import(
        dia(
            vec![folder("Later", vec![link("Read", "https://read.example/")])],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.bar()[1],
        f(
            "Imported from Dia",
            vec![f("Later", vec![u("https://read.example/")])]
        )
    );
}

#[test]
fn folders_of_the_same_name_are_matched_as_a_whole() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    p.import(
        dia(
            vec![
                folder(
                    "Same",
                    vec![
                        link("Shared", "https://shared.example/"),
                        link("A", "https://a.example/"),
                    ],
                ),
                folder(
                    "Same",
                    vec![
                        link("Shared", "https://shared.example/"),
                        link("B", "https://b.example/"),
                    ],
                ),
            ],
            vec![],
        ),
        "Dia",
    );
    p.import(
        dia(
            vec![
                folder(
                    "Same",
                    vec![
                        link("Shared", "https://shared.example/"),
                        link("New B", "https://new-b.example/"),
                    ],
                ),
                folder(
                    "Same",
                    vec![
                        link("A", "https://a.example/"),
                        link("New A", "https://new-a.example/"),
                    ],
                ),
            ],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.bar()[1],
        f(
            "Imported from Dia",
            vec![
                f(
                    "Same",
                    vec![
                        u("https://shared.example/"),
                        u("https://a.example/"),
                        u("https://new-a.example/"),
                    ]
                ),
                f(
                    "Same",
                    vec![
                        u("https://shared.example/"),
                        u("https://b.example/"),
                        u("https://new-b.example/"),
                    ]
                ),
            ]
        )
    );
}

#[test]
fn a_folder_named_imported_from_dia_by_hand_takes_the_import() {
    let mut p = Profile::start(&[]);
    let bar = p.tree.bar();
    p.add_folder(&bar, "Imported from Dia");
    p.import(dia(vec![link("A", "https://a.example/")], vec![]), "Dia");
    assert_eq!(
        p.bar(),
        vec![f("Imported from Dia", vec![u("https://a.example/")])]
    );
    p.import(
        dia(
            vec![link("A", "https://a.example/"), folder("Ideas", vec![])],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.bar(),
        vec![f(
            "Imported from Dia",
            vec![u("https://a.example/"), f("Ideas", vec![])]
        )]
    );
}

#[test]
fn another_browsers_folder_moved_into_imported_from_dia_doesnt_take_a_dia_import() {
    let mut p = Profile::start(&[]);
    p.import(
        dia(
            vec![folder("Work", vec![link("A", "https://a.example/")])],
            vec![],
        ),
        "Chrome",
    );
    p.import(
        dia(vec![link("Mail", "https://mail.example/")], vec![]),
        "Dia",
    );
    let bar = p.tree.bar();
    let chrome_work = p.child_named(&bar, "Work");
    let wrapper = p.child_named(&bar, "Imported from Dia");
    p.tree
        .move_node(chrome_work.as_str(), &wrapper, None)
        .unwrap();
    assert_eq!(
        p.import(
            dia(
                vec![
                    link("Mail", "https://mail.example/"),
                    folder(
                        "Work",
                        vec![
                            link("A", "https://a.example/"),
                            link("B", "https://b.example/")
                        ]
                    ),
                ],
                vec![]
            ),
            "Dia"
        ),
        1
    );
    assert_eq!(
        p.bar(),
        vec![f(
            "Imported from Dia",
            vec![
                u("https://mail.example/"),
                f("Work", vec![u("https://a.example/")]),
                f("Work", vec![u("https://b.example/")]),
            ]
        )]
    );
}

#[test]
fn a_folder_from_before_takes_new_links_while_one_made_by_hand_doesnt() {
    let mut p = Profile::start(&[]);
    let bar = p.tree.bar();
    let work = p.add_folder(&bar, "Work");
    p.add_link(&work, "https://a.example/");
    let notes = p.add_folder(&bar, "Notes");
    p.add_link(&notes, "https://x.example/");
    assert_eq!(
        p.import(
            dia(
                vec![folder(
                    "Work",
                    vec![
                        link("A", "https://a.example/"),
                        link("B", "https://b.example/")
                    ]
                )],
                vec![]
            ),
            "Dia"
        ),
        1
    );
    assert_eq!(
        p.bar(),
        vec![
            f(
                "Work",
                vec![u("https://a.example/"), u("https://b.example/")]
            ),
            f("Notes", vec![u("https://x.example/")]),
        ]
    );
    assert_eq!(
        p.import(
            dia(
                vec![
                    folder(
                        "Work",
                        vec![
                            link("A", "https://a.example/"),
                            link("B", "https://b.example/"),
                            link("C", "https://c.example/"),
                        ]
                    ),
                    folder("Notes", vec![link("Y", "https://y.example/")]),
                ],
                vec![]
            ),
            "Dia"
        ),
        2
    );
    assert_eq!(
        p.bar(),
        vec![
            f(
                "Work",
                vec![
                    u("https://a.example/"),
                    u("https://b.example/"),
                    u("https://c.example/"),
                ]
            ),
            f("Notes", vec![u("https://x.example/")]),
            f(
                "Imported from Dia",
                vec![f("Notes", vec![u("https://y.example/")])]
            ),
        ]
    );
}

#[test]
fn eighteen_same_named_folders_pair_by_their_links_whatever_the_order() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    let pages: Vec<String> = (0..18)
        .map(|i| format!("https://common{i}.example/"))
        .collect();
    let without = |i: usize| -> Vec<ImportedNode> {
        pages
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, url)| link("c", url))
            .collect()
    };
    p.import(
        dia(
            (0..18).map(|i| folder("Same", without(i))).collect(),
            vec![],
        ),
        "Dia",
    );
    let reversed: Vec<ImportedNode> = (0..18)
        .rev()
        .map(|i| {
            let mut children = without(i);
            children.push(link("new", &format!("https://new{i}.example/")));
            folder("Same", children)
        })
        .collect();
    assert_eq!(p.import(dia(reversed, vec![]), "Dia"), 18);
    let Shape::Folder(_, wrapped) = p.bar()[1].clone() else {
        panic!("a wrapper");
    };
    for (i, folder) in wrapped.iter().enumerate() {
        let mut expected: Vec<Shape> = pages
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, url)| u(url))
            .collect();
        expected.push(u(&format!("https://new{i}.example/")));
        assert_eq!(folder, &f("Same", expected), "folder {i}");
    }
}

#[test]
fn a_ring_of_shared_pages_pairs_by_links_not_position() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    let uu = |j: usize| format!("https://u{j}.example/");
    let vv = |j: usize| format!("https://v{j}.example/");
    p.import(
        dia(
            (0..65)
                .map(|j| folder("Same", vec![link("u", &uu(j)), link("v", &vv(j))]))
                .collect(),
            vec![],
        ),
        "Dia",
    );
    let incoming: Vec<ImportedNode> = (0..65)
        .map(|i| {
            let fresh = link("new", &format!("https://new{i}.example/"));
            if i == 64 {
                folder("Same", vec![link("u", &uu(0)), fresh])
            } else {
                folder(
                    "Same",
                    vec![link("v", &vv(i)), link("u", &uu(i + 1)), fresh],
                )
            }
        })
        .collect();
    assert_eq!(p.import(dia(incoming, vec![]), "Dia"), 65);
    let Shape::Folder(_, wrapped) = p.bar()[1].clone() else {
        panic!("a wrapper");
    };
    for (j, folder) in wrapped.iter().enumerate() {
        assert_eq!(
            folder,
            &f(
                "Same",
                vec![
                    u(&uu(j)),
                    u(&vv(j)),
                    u(&format!("https://new{}.example/", (j + 64) % 65)),
                ]
            ),
            "folder {j}"
        );
    }
}

#[test]
fn many_same_named_folders_each_take_their_own_link() {
    let mut p = Profile::start(&[("Mine", "https://mine.example/")]);
    let siblings = |extra: bool| -> Vec<ImportedNode> {
        (0..3000)
            .map(|i| {
                let mut children = vec![
                    link("common", "https://common.example/"),
                    link("a", &format!("https://s{i}.example/a")),
                ];
                if extra {
                    children.push(link("b", &format!("https://s{i}.example/b")));
                }
                folder("Folder", children)
            })
            .collect()
    };
    p.import(dia(siblings(false), vec![]), "Dia");
    let mut reversed = siblings(true);
    reversed.reverse();
    assert_eq!(p.import(dia(reversed, vec![]), "Dia"), 3000);
    let Shape::Folder(_, wrapped) = p.bar()[1].clone() else {
        panic!("a wrapper");
    };
    assert_eq!(wrapped.len(), 3000);
    for (i, folder) in wrapped.iter().enumerate() {
        assert_eq!(
            folder,
            &f(
                "Folder",
                vec![
                    u("https://common.example/"),
                    u(&format!("https://s{i}.example/a")),
                    u(&format!("https://s{i}.example/b")),
                ]
            )
        );
    }
}

#[test]
fn a_page_too_costly_to_count_doesnt_stop_cheaper_evidence() {
    let holders: HashMap<String, Vec<usize>> = [
        ("a-common".to_owned(), (0..709).collect()),
        ("z-key".to_owned(), (0..709).collect()),
    ]
    .into_iter()
    .collect();
    let pages_of: Vec<Vec<String>> = (0..709)
        .map(|i| {
            if i == 0 {
                vec!["a-common".to_owned(), "z-key".to_owned()]
            } else {
                vec!["a-common".to_owned()]
            }
        })
        .collect();
    const { assert!(709 * 709 > EDGE_WORK_BUDGET) };
    let counted = counted_pages(&pages_of, &holders);
    assert_eq!(
        counted.into_iter().collect::<Vec<_>>(),
        vec!["z-key".to_owned()]
    );
}

#[test]
fn which_folders_an_import_made_is_kept_for_the_next_run() {
    let mut p = Profile::start(&[]);
    p.import(
        dia(
            vec![folder("Work", vec![link("A", "https://a.example/")])],
            vec![],
        ),
        "Dia",
    );
    let bar = p.tree.bar();
    let work = p.child_named(&bar, "Work");
    assert_eq!(
        p.made.get(work.as_str()),
        Some(&ImportedFolder {
            source: "Dia".into(),
            engine: "default".into(),
            wrapper: false,
            adopted: false,
        })
    );
    p.import(
        dia(
            vec![folder(
                "Work",
                vec![
                    link("A", "https://a.example/"),
                    link("B", "https://b.example/"),
                ],
            )],
            vec![],
        ),
        "Dia",
    );
    assert_eq!(
        p.bar(),
        vec![f(
            "Work",
            vec![u("https://a.example/"), u("https://b.example/")]
        )]
    );
}
